(function(){
"use strict";

/* ============================================================
   1. CONEXIÓN A SUPABASE (base de datos + autenticación + archivos en la nube)
   ------------------------------------------------------------
   Esta versión ya NO guarda los datos en el navegador (IndexedDB).
   Todo vive en tu proyecto de Supabase, así que los 2-5 usuarios
   ven la misma información en tiempo real, desde cualquier equipo,
   siempre que haya conexión a internet.
   ============================================================ */
const SUPABASE_URL = "https://ntuunyaqxqcylfthzfoo.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_fPHIAnrSmkoE0vkA9r7Hqw_pOJ0O5ca";
const DOCS_BUCKET = "documentos";

const sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Nombre de "store" (como en IndexedDB) -> nombre real de la tabla en Postgres
const STORE_TABLE = {
  processes: "processes",
  actuaciones: "actuaciones",
  documentos: "documentos",
  personas: "personas",
  notas_items: "notas_items",
  tareas: "tareas",
  historial: "historial",
  meta: "app_meta",
};
// Tablas "hijas" que en la app usan processId (camelCase) pero en la
// base de datos la columna se llama process_id (snake_case)
const CHILD_STORES = new Set(["actuaciones","documentos","personas","notas_items","tareas","historial"]);

function toRow(store, obj){
  const row = { ...obj };
  if(CHILD_STORES.has(store) && "processId" in row){
    row.process_id = row.processId;
    delete row.processId;
  }
  if(store==="processes" && "_waSent" in row){
    row.wa_sent = row._waSent;
    delete row._waSent;
  }
  return row;
}
function fromRow(store, row){
  if(!row) return row;
  const obj = { ...row };
  if(CHILD_STORES.has(store) && "process_id" in obj){
    obj.processId = obj.process_id;
    delete obj.process_id;
  }
  if(store==="processes" && "wa_sent" in obj){
    obj._waSent = obj.wa_sent || {};
    delete obj.wa_sent;
  }
  return obj;
}

const DB = {
  async add(store, obj){
    const table = STORE_TABLE[store];
    if(store==="meta"){
      const { data, error } = await sbClient.from(table).upsert({key:obj.key, value:obj.value}).select().single();
      if(error) throw error;
      return data;
    }
    const { data, error } = await sbClient.from(table).insert(toRow(store,obj)).select().single();
    if(error) throw error;
    return fromRow(store,data).id;
  },
  async put(store, obj){
    const table = STORE_TABLE[store];
    if(store==="meta"){
      const { error } = await sbClient.from(table).upsert({key:obj.key, value:obj.value});
      if(error) throw error;
      return obj;
    }
    const { error } = await sbClient.from(table).update(toRow(store,obj)).eq("id", obj.id);
    if(error) throw error;
    return obj;
  },
  async get(store, key){
    const table = STORE_TABLE[store];
    if(store==="meta"){
      const { data, error } = await sbClient.from(table).select("*").eq("key", key).maybeSingle();
      if(error) throw error;
      return data ? {key:data.key, value:data.value} : undefined;
    }
    const { data, error } = await sbClient.from(table).select("*").eq("id", key).maybeSingle();
    if(error) throw error;
    return fromRow(store, data);
  },
  async del(store, key){
    const table = STORE_TABLE[store];
    const col = store==="meta" ? "key" : "id";
    const { error } = await sbClient.from(table).delete().eq(col, key);
    if(error) throw error;
  },
  async all(store){
    const table = STORE_TABLE[store];
    const { data, error } = await sbClient.from(table).select("*").order("id",{ascending:true}).limit(5000);
    if(error) throw error;
    if(store==="meta") return (data||[]).map(r=>({key:r.key, value:r.value}));
    return (data||[]).map(r=>fromRow(store,r));
  },
  async byIndex(store, idx, val){
    const table = STORE_TABLE[store];
    const col = idx==="processId" ? "process_id" : idx;
    const { data, error } = await sbClient.from(table).select("*").eq(col, val);
    if(error) throw error;
    return (data||[]).map(r=>fromRow(store,r));
  },
  async clear(store){
    const table = STORE_TABLE[store];
    const col = store==="meta" ? "key" : "id";
    const { error } = await sbClient.from(table).delete().neq(col, "___imposible___");
    if(error) throw error;
  },
};

/* ---- Autenticación ---- */
const loginOverlay = document.getElementById("login-overlay");
function showLogin(){ loginOverlay.classList.add("open"); }
function hideLogin(){ loginOverlay.classList.remove("open"); }

async function doLogin(){
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errBox = document.getElementById("login-error");
  errBox.classList.add("hidden");
  if(!email || !password){ errBox.textContent = "Ingresa tu correo y tu contraseña."; errBox.classList.remove("hidden"); return; }
  const { error } = await sbClient.auth.signInWithPassword({ email, password });
  if(error){ errBox.textContent = "No pudimos iniciar sesión: " + error.message; errBox.classList.remove("hidden"); return; }
  hideLogin();
  await onAuthReady();
}
document.getElementById("btn-login").addEventListener("click", doLogin);
document.getElementById("login-password").addEventListener("keydown",(e)=>{ if(e.key==="Enter") doLogin(); });
document.getElementById("btn-forgot-password").addEventListener("click", async ()=>{
  const email = document.getElementById("login-email").value.trim();
  if(!email){ toast("Escribe tu correo arriba primero","err"); return; }
  const { error } = await sbClient.auth.resetPasswordForEmail(email);
  if(error){ toast("No se pudo enviar el correo: "+error.message,"err"); return; }
  toast("Te enviamos un correo para restablecer tu contraseña","ok");
});
document.getElementById("btn-logout").addEventListener("click", async ()=>{
  await sbClient.auth.signOut();
  location.reload();
});

let REALTIME_WIRED = false;
function wireRealtimeSync(){
  if(REALTIME_WIRED) return;
  REALTIME_WIRED = true;
  let debounceTimer = null;
  const debouncedRefresh = ()=>{ clearTimeout(debounceTimer); debounceTimer = setTimeout(()=>refreshAll(), 600); };
  const tables = ["processes","actuaciones","documentos","personas","notas_items","tareas","historial"];
  const channel = sbClient.channel("ocid-realtime");
  tables.forEach(t=> channel.on("postgres_changes", {event:"*", schema:"public", table:t}, debouncedRefresh));
  channel.subscribe();
}

async function onAuthReady(){
  const { data: { session } } = await sbClient.auth.getSession();
  if(!session){ showLogin(); return; }
  document.getElementById("sb-user-email").textContent = session.user.email;
  wireRealtimeSync();
  await refreshAll();
}


/* ============================================================
   2. FESTIVOS COLOMBIANOS + CÁLCULO DE DÍAS HÁBILES
   ============================================================ */
function easterDate(year){ // algoritmo de Meeus/Jones/Butcher
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,
    f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,
    i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),
    month=Math.floor((h+l-7*m+114)/31), day=((h+l-7*m+114)%31)+1;
  return new Date(year,month-1,day);
}
function addDays(d,n){ const r=new Date(d); r.setDate(r.getDate()+n); return r; }
function nextMonday(d){ const wd=d.getDay(); if(wd===1) return new Date(d); const add=(8-wd)%7 || 7; return addDays(d, wd===0?1:add); }
function ymd(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }

function colombianHolidays(year){
  const list = [];
  const push=(d)=>list.push(ymd(d));
  push(new Date(year,0,1)); push(new Date(year,4,1)); push(new Date(year,6,20));
  push(new Date(year,7,7)); push(new Date(year,11,8)); push(new Date(year,11,25));
  const moved = [[0,6],[2,19],[5,29],[7,15],[9,12],[10,1],[10,11]];
  moved.forEach(([m,day])=> push(nextMonday(new Date(year,m,day))));
  const easter = easterDate(year);
  push(addDays(easter,-3)); push(addDays(easter,-2));
  push(nextMonday(addDays(easter,39)));
  push(nextMonday(addDays(easter,60)));
  push(nextMonday(addDays(easter,68)));
  return new Set(list);
}
let holidaysCache = {};
function getHolidaySet(year){
  if(!holidaysCache[year]) holidaysCache[year] = colombianHolidays(year);
  return holidaysCache[year];
}
function isBusinessDay(d, extraHolidays){
  const wd=d.getDay(); if(wd===0||wd===6) return false;
  const set = getHolidaySet(d.getFullYear());
  const key = ymd(d);
  if(set.has(key)) return false;
  if(extraHolidays && extraHolidays.has(key)) return false;
  return true;
}
function addBusinessDays(startDate, n, extraHolidays){
  let d = new Date(startDate), count=0;
  if(n<=0) return d;
  while(count<n){ d = addDays(d,1); if(isBusinessDay(d, extraHolidays)) count++; }
  return d;
}
function businessDaysBetween(from,to){
  if(to<from) return -businessDaysBetween(to,from);
  let d=new Date(from), n=0;
  while(ymd(d)!==ymd(to)){ d=addDays(d,1); if(isBusinessDay(d)) n++; }
  return n;
}

/* ============================================================
   3. ESTADO GLOBAL Y CONSTANTES
   ============================================================ */
const ESTADOS = ["Indagación previa","Investigación disciplinaria","Inhibitorio","Acumulado","Archivado"];
const KANBAN_COLS = ["Indagación previa","Investigación disciplinaria","Acumulado","Archivado"];
const FOLDERS = ["Expediente Completo","Autos","Oficios","Pruebas","Declaraciones","Notificaciones","Otros"];
const TERM_PLANTILLAS = [
  {nombre:"Pruebas", dias:10},{nombre:"Notificación personal", dias:5},{nombre:"Edicto", dias:3}
];

let STATE = {
  view:"dashboard",
  processes:[],
  filters:{ estado:new Set(), anio:new Set(), prioridad:new Set(), quick:null },
  search:"",
  sort:{col:"radicado", dir:1},
  visibleCols:{radicado:1,investigado:1,estado:1,prioridad:1,fechaApertura:1,fechaVencimiento:1},
  calDate:new Date(),
  currentProcessId:null,
  currentTab:"resumen",
};

function toast(msg, kind){
  const el=document.createElement("div"); el.className="toast"+(kind?(" "+kind):"");
  el.textContent=msg; document.getElementById("toast-wrap").appendChild(el);
  setTimeout(()=>el.remove(),3400);
}
function esc(s){ return (s==null?"":String(s)).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function fmtDate(s){ if(!s) return "—"; const d=new Date(s+"T00:00:00"); if(isNaN(d)) return s; return d.toLocaleDateString("es-CO",{day:"2-digit",month:"short",year:"numeric"}); }
function todayStr(){ return ymd(new Date()); }

async function logHistorial(processId, cambio){
  await DB.add("historial",{processId, fecha:new Date().toISOString(), cambio, usuario:"Usuario local"});
}

/* ============================================================
   4. CARGA Y REFRESCO
   ============================================================ */
async function reloadProcesses(){
  STATE.processes = await DB.all("processes");
  renderSidebarCounts();
}
async function refreshAll(){
  await reloadProcesses();
  renderCurrentView();
  updateGlobalTasksBadge();
  checkWhatsappAlerts();
}

/* ============================================================
   5. NAVEGACIÓN / SIDEBAR
   ============================================================ */
function isMobileViewport(){ return window.innerWidth <= 900; }
function openSidebar(){
  document.getElementById("sidebar").classList.remove("collapsed");
  if(isMobileViewport()) document.getElementById("sidebar-backdrop").classList.add("show");
}
function closeSidebar(){
  document.getElementById("sidebar").classList.add("collapsed");
  document.getElementById("sidebar-backdrop").classList.remove("show");
}
function toggleSidebar(){
  const collapsed = document.getElementById("sidebar").classList.contains("collapsed");
  if(collapsed) openSidebar(); else closeSidebar();
}
// En móvil el panel arranca cerrado para dejar toda la pantalla al contenido.
if(isMobileViewport()) document.getElementById("sidebar").classList.add("collapsed");
document.getElementById("sidebar-backdrop").addEventListener("click", closeSidebar);

document.querySelectorAll(".sb-item[data-view]").forEach(el=>{
  el.addEventListener("click",()=>{
    document.querySelectorAll(".sb-item[data-view]").forEach(x=>x.classList.remove("active"));
    el.classList.add("active");
    STATE.view = el.dataset.view;
    document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
    document.getElementById("view-"+STATE.view).classList.add("active");
    const titles={dashboard:"Dashboard",kanban:"Vista Kanban",table:"Vista Tabla",calendar:"Calendario",stats:"Estadísticas"};
    document.getElementById("view-title").textContent = titles[STATE.view];
    renderCurrentView();
    if(isMobileViewport()) closeSidebar();
  });
});
document.querySelectorAll(".sb-item[data-filter-state]").forEach(el=>{
  el.addEventListener("click",()=>{
    STATE.filters.quick = el.dataset.filterState;
    document.querySelector('.sb-item[data-view="table"]').click();
  });
});
document.getElementById("btn-toggle-sidebar").addEventListener("click", toggleSidebar);
document.getElementById("theme-toggle").addEventListener("click",async ()=>{
  const html=document.documentElement;
  const next = html.getAttribute("data-theme")==="dark"?"light":"dark";
  html.setAttribute("data-theme", next);
  document.getElementById("theme-toggle").querySelector(".dot").textContent = next==="dark"?"☀":"☾";
  await DB.put("meta",{key:"theme", value:next});
});

function renderCurrentView(){
  if(STATE.view==="dashboard") renderDashboard();
  else if(STATE.view==="kanban") renderKanban();
  else if(STATE.view==="table") renderTable();
  else if(STATE.view==="calendar") renderCalendar();
  else if(STATE.view==="stats") renderStats();
}

function renderSidebarCounts(){
  const total = STATE.processes.length;
  const archived = STATE.processes.filter(p=>p.estado==="Archivado").length;
  const active = total-archived;
  const overdue = STATE.processes.filter(p=>getOverdueTerms(p).length>0).length;
  document.getElementById("cnt-active").textContent = active;
  document.getElementById("cnt-overdue").textContent = overdue;
  document.getElementById("cnt-archived").textContent = archived;
}

/* ============================================================
   6. TÉRMINOS: helpers sobre un proceso
   ============================================================ */
function getAllTerms(p){
  // Combina los términos manuales (pestaña Términos) con la fecha de vencimiento
  // general del proceso, para que ambas disparen alertas, calendario y colores.
  const arr = [...(p.terminos||[])];
  if(p.fechaVencimiento){
    arr.push({ nombre:"Vencimiento del proceso", fechaVence:p.fechaVencimiento, cumplido: p.estado==="Archivado" });
  }
  return arr;
}
function getOverdueTerms(p){
  if(p.estado==="Archivado") return [];
  return getAllTerms(p).filter(t=>!t.cumplido && t.fechaVence && t.fechaVence < todayStr());
}
function getUpcomingTerms(p, days){
  if(p.estado==="Archivado") return [];
  const limit = ymd(addDays(new Date(), days));
  return getAllTerms(p).filter(t=>!t.cumplido && t.fechaVence && t.fechaVence>=todayStr() && t.fechaVence<=limit);
}

/* ============================================================
   7. DASHBOARD
   ============================================================ */
function renderDashboard(){
  const ps = STATE.processes;
  const archived = ps.filter(p=>p.estado==="Archivado");
  const activos = ps.filter(p=>p.estado!=="Archivado");
  const investigacion = ps.filter(p=>p.estado==="Investigación disciplinaria");
  const indagacion = ps.filter(p=>p.estado==="Indagación previa");
  const vencen7 = ps.filter(p=>getUpcomingTerms(p,7).length>0);
  document.getElementById("kpi-total").textContent = ps.length;
  document.getElementById("kpi-activos").textContent = activos.length;
  document.getElementById("kpi-investigacion").textContent = investigacion.length;
  document.getElementById("kpi-indagacion").textContent = indagacion.length;
  document.getElementById("kpi-archivados").textContent = archived.length;
  document.getElementById("kpi-vencen").textContent = vencen7.length;

  // alertas
  let alertItems = [];
  ps.forEach(p=>{
    getOverdueTerms(p).forEach(t=> alertItems.push({p,t,kind:"red"}));
    getUpcomingTerms(p,7).forEach(t=> alertItems.push({p,t,kind: t.fechaVence===todayStr()?"yellow":"green"}));
  });
  alertItems.sort((a,b)=> a.t.fechaVence.localeCompare(b.t.fechaVence));
  document.getElementById("alert-cnt").textContent = alertItems.length;
  const alertsEl = document.getElementById("alerts-list");
  alertsEl.innerHTML = alertItems.length? alertItems.slice(0,10).map(a=>`
    <div class="alert-row" data-open="${a.p.id}">
      <span class="dot-ind ${a.kind}"></span>
      <div class="txt">
        <div class="radicado">${esc(a.p.radicado||"(sin radicado)")} — ${esc(a.t.nombre)}</div>
        <div class="meta">${esc(a.p.investigado||"")} · vence ${fmtDate(a.t.fechaVence)}</div>
      </div>
    </div>`).join("") : `<div class="empty-hint">No hay alertas de términos por ahora.</div>`;
  alertsEl.querySelectorAll("[data-open]").forEach(el=> el.addEventListener("click",()=>openProcessModal(Number(el.dataset.open))));

  // distribución de procesos (pizza: archivados, investigación, indagación)
  renderDistribucionPie(archived.length, investigacion.length, indagacion.length, ps.length);

  // actividad reciente (compacta)
  DB.all("historial").then(all=>{
    all.sort((a,b)=> b.fecha.localeCompare(a.fecha));
    const el = document.getElementById("recent-activity");
    const top = all.slice(0,5);
    el.innerHTML = top.length? top.map(h=>{
      const p = ps.find(x=>x.id===h.processId);
      return `<div class="alert-row" data-open="${h.processId}"><span class="dot-ind green"></span><div class="txt"><div class="radicado">${esc(p?p.radicado:"Proceso")}</div><div class="meta">${esc(h.cambio)} · ${new Date(h.fecha).toLocaleString("es-CO")}</div></div></div>`;
    }).join("") : `<div class="empty-hint">Aún no hay actividad registrada.</div>`;
    el.querySelectorAll("[data-open]").forEach(x=>x.addEventListener("click",()=>openProcessModal(Number(x.dataset.open))));
  });

  // mini calendario del mes actual con puntos
  renderMiniCalendar();

  // recientes
  const rec = [...ps].sort((a,b)=>(b.actualizadoEn||"").localeCompare(a.actualizadoEn||"")).slice(0,6);
  const recEl = document.getElementById("recent-processes");
  recEl.innerHTML = rec.length? rec.map(p=>`
    <div class="alert-row" data-open="${p.id}">
      ${estadoBadge(p)}
      <div class="txt"><div class="radicado">${esc(p.radicado||"(sin radicado)")}</div><div class="meta">${esc(p.investigado||"")}</div></div>
    </div>`).join("") : `<div class="empty-hint">Crea tu primer proceso para verlo aquí.</div>`;
  recEl.querySelectorAll("[data-open]").forEach(el=> el.addEventListener("click",()=>openProcessModal(Number(el.dataset.open))));
}

function renderDistribucionPie(nArchivados, nInvestigacion, nIndagacion, total){
  const el = document.getElementById("pie-distribucion");
  if(!total){ el.innerHTML = `<div class="empty-hint">Crea procesos para ver la distribución.</div>`; return; }
  const otros = Math.max(0, total - nArchivados - nInvestigacion - nIndagacion);
  const segments = [
    {label:"Archivados", value:nArchivados, color:"var(--text-muted)"},
    {label:"Investigación", value:nInvestigacion, color:"var(--accent)"},
    {label:"Indagación", value:nIndagacion, color:"var(--warning)"},
  ];
  if(otros>0) segments.push({label:"Otros estados", value:otros, color:"var(--border)"});
  const R=78, CX=86, CY=86;
  let acc = 0;
  const resolvedColors = segments.map(s=>{
    const tmp = document.createElement("div"); tmp.style.color = s.color; document.body.appendChild(tmp);
    const c = getComputedStyle(tmp).color; tmp.remove(); return c;
  });
  let paths = "";
  segments.forEach((s,i)=>{
    if(s.value<=0) return;
    const frac = s.value/total;
    const startAngle = acc*2*Math.PI - Math.PI/2;
    acc += frac;
    const endAngle = acc*2*Math.PI - Math.PI/2;
    const x1 = CX + R*Math.cos(startAngle), y1 = CY + R*Math.sin(startAngle);
    const x2 = CX + R*Math.cos(endAngle), y2 = CY + R*Math.sin(endAngle);
    const large = frac>0.5 ? 1 : 0;
    if(frac>=0.9999){
      paths += `<circle cx="${CX}" cy="${CY}" r="${R}" fill="${resolvedColors[i]}"></circle>`;
    } else {
      paths += `<path d="M${CX},${CY} L${x1.toFixed(2)},${y1.toFixed(2)} A${R},${R} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${resolvedColors[i]}"></path>`;
    }
  });
  const svg = `<svg viewBox="0 0 172 172" width="190" height="190">${paths}<circle cx="${CX}" cy="${CY}" r="44" fill="var(--surface)"></circle></svg>`;
  const legend = segments.filter(s=>s.value>0).map(s=>`
    <div class="li"><span class="sw" style="background:${s.color};"></span><span class="lbl2">${esc(s.label)}</span><span class="num">${s.value}</span></div>`).join("");
  el.innerHTML = `<div class="pie-wrap"><div>${svg}</div><div class="pie-legend">${legend}</div></div>`;
}

async function renderMiniCalendar(){
  const acts = await DB.all("actuaciones");
  const now = new Date(); const y=now.getFullYear(), m=now.getMonth();
  const first = new Date(y,m,1); const startWd = first.getDay();
  const daysInMonth = new Date(y,m+1,0).getDate();
  let html = `<div class="cal-grid" style="font-size:11px;">`;
  ["D","L","M","X","J","V","S"].forEach(d=> html+=`<div class="cal-dow">${d}</div>`);
  for(let i=0;i<startWd;i++) html+=`<div class="cal-cell other"></div>`;
  const termsByDay = {};
  STATE.processes.forEach(p=> getAllTerms(p).forEach(t=>{ if(!t.cumplido && t.fechaVence){ (termsByDay[t.fechaVence]=termsByDay[t.fechaVence]||[]).push(t); } }));
  const actsByDay = {};
  acts.forEach(a=>{ (actsByDay[a.fecha]=actsByDay[a.fecha]||[]).push(a); });
  for(let d=1; d<=daysInMonth; d++){
    const key = ymd(new Date(y,m,d));
    const isToday = key===todayStr();
    let dots="";
    if(termsByDay[key]) dots += `<div style="display:flex;gap:2px;justify-content:center;margin-top:3px;"><span class="dot-ind ${key<todayStr()?'red':'yellow'}"></span></div>`;
    if(actsByDay[key]) dots += `<div style="display:flex;gap:2px;justify-content:center;margin-top:1px;"><span class="dot-ind green"></span></div>`;
    html += `<div class="cal-cell ${isToday?'today':''}"><div class="dnum">${d}</div>${dots}</div>`;
  }
  html += `</div>`;
  document.getElementById("mini-calendar").innerHTML = html;
}

/* ============================================================
   8. KANBAN
   ============================================================ */
function renderKanban(){
  const tb = document.getElementById("kanban-toolbar");
  tb.innerHTML = `<div style="font-size:12.5px;color:var(--text-muted);">Arrastra una tarjeta para cambiar el estado del proceso.</div>`;
  const board = document.getElementById("kanban-board");
  board.innerHTML = "";
  KANBAN_COLS.forEach(col=>{
    const items = STATE.processes.filter(p=>p.estado===col);
    const colEl = document.createElement("div");
    colEl.className="kcol"; colEl.dataset.col=col;
    colEl.innerHTML = `<div class="kcol-head">${esc(col)}<span class="n">${items.length}</span></div>`;
    items.forEach(p=>{
      const c = document.createElement("div");
      c.className="kcard"; c.draggable=true; c.dataset.id=p.id;
      const overdue = getOverdueTerms(p).length;
      c.innerHTML = `
        <div class="kc-top"><span class="rad">${esc(p.radicado||"(sin radicado)")}</span>${prioBadge(p.prioridad)}</div>
        <div class="who">${esc(p.investigado||"Sin investigado")}</div>
        <div class="kc-tags">${overdue?`<span class="badge priority-alta">${overdue} vencido${overdue>1?'s':''}</span>`:""}</div>`;
      c.addEventListener("dragstart",()=>{ c.classList.add("dragging"); });
      c.addEventListener("dragend",()=>{ c.classList.remove("dragging"); });
      c.addEventListener("click",(e)=>{ if(!c.classList.contains("dragging")) openProcessModal(p.id); });
      colEl.appendChild(c);
    });
    colEl.addEventListener("dragover",(e)=>{ e.preventDefault(); colEl.classList.add("dragover"); });
    colEl.addEventListener("dragleave",()=> colEl.classList.remove("dragover"));
    colEl.addEventListener("drop", async (e)=>{
      e.preventDefault(); colEl.classList.remove("dragover");
      const dragging = document.querySelector(".kcard.dragging");
      if(!dragging) return;
      const id = Number(dragging.dataset.id);
      const p = STATE.processes.find(x=>x.id===id);
      if(p && p.estado!==col){
        const prev = p.estado;
        p.estado = col; p.actualizadoEn = new Date().toISOString();
        await DB.put("processes", p);
        await logHistorial(id, `Estado cambiado de "${prev}" a "${col}" (kanban)`);
        toast("Estado actualizado","ok");
        await refreshAll();
      }
    });
    board.appendChild(colEl);
  });
}
function prioBadge(pr){
  if(!pr) return "";
  const cls = pr==="Alta"?"priority-alta":pr==="Media"?"priority-media":"priority-baja";
  const ic = pr==="Alta"?"🔴":pr==="Media"?"🟡":"🟢";
  return `<span class="badge ${cls}">${ic} ${esc(pr)}</span>`;
}
function estadoBadge(p){
  const label = p.motivoArchivo ? `${p.estado} · ${p.motivoArchivo}` : (p.estado||"");
  return `<span class="badge state">${esc(label)}</span>`;
}

/* ============================================================
   9. TABLA
   ============================================================ */
const TABLE_COLS = [
  {key:"radicado",lbl:"Radicado"},
  {key:"investigado",lbl:"Investigado"},{key:"estado",lbl:"Estado"},
  {key:"prioridad",lbl:"Prioridad"},
  {key:"fechaApertura",lbl:"Apertura"},{key:"fechaVencimiento",lbl:"Vencimiento"},
];
function filteredProcesses(){
  let arr = [...STATE.processes];
  const f = STATE.filters;
  if(f.quick==="__active__") arr = arr.filter(p=>p.estado!=="Archivado");
  else if(f.quick==="__vencidos__") arr = arr.filter(p=>getOverdueTerms(p).length>0);
  else if(f.quick==="Archivado") arr = arr.filter(p=>p.estado==="Archivado");
  if(f.estado.size) arr = arr.filter(p=>f.estado.has(p.estado));
  if(f.prioridad.size) arr = arr.filter(p=>f.prioridad.has(p.prioridad));
  if(f.anio.size) arr = arr.filter(p=> p.fechaApertura && f.anio.has(String(new Date(p.fechaApertura+"T00:00:00").getFullYear())));
  if(STATE.search){
    const q = STATE.search.toLowerCase();
    arr = arr.filter(p=> [p.radicado,p.investigado,p.quejoso,p.observaciones].some(v=> (v||"").toLowerCase().includes(q)));
  }
  const {col,dir} = STATE.sort;
  arr.sort((a,b)=> (String(a[col]||"")).localeCompare(String(b[col]||""))*dir);
  return arr;
}
function uniqVals(key){ return [...new Set(STATE.processes.map(p=>p[key]).filter(Boolean))].sort(); }
function uniqYears(){ return [...new Set(STATE.processes.map(p=>p.fechaApertura && new Date(p.fechaApertura+"T00:00:00").getFullYear()).filter(Boolean))].sort((a,b)=>b-a).map(String); }

function makeFilterChip(label, key, options){
  const wrap = document.createElement("div"); wrap.className="chip-select";
  const active = STATE.filters[key].size;
  wrap.innerHTML = `<button>${label}${active?` (${active})`:""} ▾</button><div class="dd">${options.map(o=>`
    <label class="dd-item"><input type="checkbox" value="${esc(o)}" ${STATE.filters[key].has(o)?"checked":""}> ${esc(o)}</label>`).join("")||'<div class="dd-item">Sin opciones</div>'}</div>`;
  wrap.querySelector("button").addEventListener("click",(e)=>{ e.stopPropagation(); document.querySelectorAll(".chip-select .dd").forEach(d=>d!==wrap.querySelector(".dd")&&d.classList.remove("open")); wrap.querySelector(".dd").classList.toggle("open"); });
  wrap.querySelectorAll("input").forEach(inp=> inp.addEventListener("change",()=>{
    if(inp.checked) STATE.filters[key].add(inp.value); else STATE.filters[key].delete(inp.value);
    renderTable();
  }));
  return wrap;
}
document.addEventListener("click",()=> document.querySelectorAll(".chip-select .dd.open").forEach(d=>d.classList.remove("open")));

function renderTable(){
  const tb = document.getElementById("table-toolbar");
  tb.innerHTML = "";
  const searchWrap = document.createElement("input");
  searchWrap.type="text"; searchWrap.placeholder="Filtrar en esta vista..."; searchWrap.style.maxWidth="220px";
  searchWrap.value = STATE.search;
  searchWrap.addEventListener("input",(e)=>{ STATE.search=e.target.value; renderTable(); });
  tb.appendChild(searchWrap);
  tb.appendChild(makeFilterChip("Estado","estado",ESTADOS));
  tb.appendChild(makeFilterChip("Año","anio",uniqYears()));
  tb.appendChild(makeFilterChip("Prioridad","prioridad",["Alta","Media","Baja"]));
  const grow = document.createElement("div"); grow.className="flexgrow"; tb.appendChild(grow);
  const colChip = makeFilterChip("Columnas","__cols__dummy" in STATE.filters?"__cols__dummy":"estado",[]); // placeholder unused
  const colsBtn = document.createElement("div"); colsBtn.className="chip-select";
  colsBtn.innerHTML = `<button>Columnas ▾</button><div class="dd">${TABLE_COLS.map(c=>`<label class="dd-item"><input type="checkbox" data-col="${c.key}" ${STATE.visibleCols[c.key]?"checked":""}> ${c.lbl}</label>`).join("")}</div>`;
  colsBtn.querySelector("button").addEventListener("click",(e)=>{e.stopPropagation(); colsBtn.querySelector(".dd").classList.toggle("open");});
  colsBtn.querySelectorAll("input").forEach(inp=> inp.addEventListener("change",()=>{ STATE.visibleCols[inp.dataset.col]=inp.checked; renderTable(); }));
  tb.appendChild(colsBtn);
  const clearBtn = document.createElement("button"); clearBtn.className="btn sm"; clearBtn.textContent="Limpiar filtros";
  clearBtn.addEventListener("click",()=>{ STATE.filters={estado:new Set(),anio:new Set(),prioridad:new Set(),quick:null}; STATE.search=""; renderTable(); });
  tb.appendChild(clearBtn);
  const exportBtn = document.createElement("button"); exportBtn.className="btn sm primary"; exportBtn.textContent="Exportar Excel (CSV)";
  exportBtn.addEventListener("click", exportTableCSV);
  tb.appendChild(exportBtn);

  const cols = TABLE_COLS.filter(c=>STATE.visibleCols[c.key]);
  const head = document.getElementById("table-head");
  head.innerHTML = cols.map(c=>`<th data-col="${c.key}">${c.lbl}${STATE.sort.col===c.key?(STATE.sort.dir===1?" ↑":" ↓"):""}</th>`).join("");
  head.querySelectorAll("th").forEach(th=> th.addEventListener("click",()=>{
    const k = th.dataset.col;
    if(STATE.sort.col===k) STATE.sort.dir*=-1; else STATE.sort={col:k,dir:1};
    renderTable();
  }));
  const rows = filteredProcesses();
  const body = document.getElementById("table-body");
  body.innerHTML = rows.map(p=>`<tr data-id="${p.id}">${cols.map(c=>{
    let v = p[c.key];
    if(c.key==="fechaApertura") v = fmtDate(v);
    else if(c.key==="fechaVencimiento"){
      const overdue = v && v<todayStr() && p.estado!=="Archivado";
      const soon = v && !overdue && v<=ymd(addDays(new Date(),7)) && p.estado!=="Archivado";
      const color = overdue?"var(--danger)":soon?"var(--warning)":"inherit";
      const weight = (overdue||soon)?"700":"inherit";
      v = `<span style="color:${color};font-weight:${weight};">${fmtDate(v)}${overdue?" ⚠️":soon?" ⏳":""}</span>`;
    }
    else if(c.key==="estado") v = estadoBadge(p);
    else if(c.key==="prioridad") v = prioBadge(v);
    else v = esc(v||"");
    return `<td>${v}</td>`;
  }).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length}" style="text-align:center;color:var(--text-muted);padding:30px;">Sin resultados. Crea un proceso o ajusta los filtros.</td></tr>`;
  body.querySelectorAll("tr[data-id]").forEach(tr=> tr.addEventListener("click",()=> openProcessModal(Number(tr.dataset.id))));
  document.getElementById("view-sub").textContent = rows.length + " proceso(s)";
}
function exportTableCSV(){
  const cols = TABLE_COLS.filter(c=>STATE.visibleCols[c.key]);
  const rows = filteredProcesses();
  let csv = cols.map(c=>`"${c.lbl}"`).join(",")+"\n";
  rows.forEach(p=>{ csv += cols.map(c=>`"${String(p[c.key]||"").replace(/"/g,'""')}"`).join(",")+"\n"; });
  downloadBlob(csv, "text/csv;charset=utf-8", `lextracker_procesos_${todayStr()}.csv`);
  toast("Exportado a CSV (compatible con Excel)","ok");
}
function downloadBlob(content, mime, filename){
  const blob = new Blob([content],{type:mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
}

/* ============================================================
   10. CALENDARIO
   ============================================================ */
document.getElementById("cal-prev").addEventListener("click",()=>{ STATE.calDate.setMonth(STATE.calDate.getMonth()-1); renderCalendar(); });
document.getElementById("cal-next").addEventListener("click",()=>{ STATE.calDate.setMonth(STATE.calDate.getMonth()+1); renderCalendar(); });
document.getElementById("cal-today").addEventListener("click",()=>{ STATE.calDate=new Date(); renderCalendar(); });

async function renderCalendar(){
  const d = STATE.calDate; const y=d.getFullYear(), m=d.getMonth();
  document.getElementById("cal-label").textContent = d.toLocaleDateString("es-CO",{month:"long",year:"numeric"});
  const acts = await DB.all("actuaciones");
  const evByDay = {};
  acts.forEach(a=>{ if(!a.fecha) return; const lbl=(a.hora?a.hora+" · ":"")+(a.titulo||a.descripcion||"Actuación"); (evByDay[a.fecha]=evByDay[a.fecha]||[]).push({type:"act",label:lbl, pid:a.processId}); });
  STATE.processes.forEach(p=> getAllTerms(p).forEach(t=>{ if(!t.cumplido && t.fechaVence){ (evByDay[t.fechaVence]=evByDay[t.fechaVence]||[]).push({type:"due",label:`${t.nombre} — ${p.radicado||"sin radicado"}`, pid:p.id}); } }));
  const first = new Date(y,m,1); const startWd = first.getDay(); const daysInMonth = new Date(y,m+1,0).getDate();
  const prevDays = new Date(y,m,0).getDate();
  let html = "";
  ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"].forEach(d2=> html+=`<div class="cal-dow">${d2}</div>`);
  for(let i=0;i<startWd;i++) html += `<div class="cal-cell other"><div class="dnum">${prevDays-startWd+i+1}</div></div>`;
  for(let day=1; day<=daysInMonth; day++){
    const key = ymd(new Date(y,m,day));
    const isToday = key===todayStr();
    const evs = (evByDay[key]||[]).slice(0,3);
    html += `<div class="cal-cell ${isToday?'today':''}"><div class="dnum">${day}</div>${evs.map(e=>`<div class="cal-evt ${e.type}" data-pid="${e.pid}" title="${esc(e.label)}">${esc(e.label)}</div>`).join("")}${(evByDay[key]||[]).length>3?`<div style="font-size:10px;color:var(--text-muted);">+${(evByDay[key]||[]).length-3} más</div>`:""}</div>`;
  }
  const total = startWd+daysInMonth; const rem = (7-(total%7))%7;
  for(let i=1;i<=rem;i++) html += `<div class="cal-cell other"><div class="dnum">${i}</div></div>`;
  const grid = document.getElementById("cal-grid"); grid.innerHTML = html;
  grid.querySelectorAll("[data-pid]").forEach(el=> el.addEventListener("click",(e)=>{ e.stopPropagation(); openProcessModal(Number(el.dataset.pid)); }));
}

function openCalendarEventForm(){
  if(!STATE.processes.length){ toast("Primero crea al menos un proceso para poder vincular el evento","err"); return; }
  const options = [...STATE.processes].sort((a,b)=>(a.radicado||"").localeCompare(b.radicado||"")).map(p=>`<option value="${p.id}">${esc(p.radicado||"(sin radicado)")} — ${esc(p.investigado||"")}</option>`).join("");
  const overlay = smallModal("Nuevo evento de calendario", `
    <div class="field"><label class="field-label">Proceso (radicado)</label><select id="ce-proceso">${options}</select></div>
    <div class="field"><label class="field-label">Título del evento</label><input type="text" id="ce-titulo" placeholder="Ej: Audiencia de descargos / Declaración"></div>
    <div class="grid2">
      <div class="field"><label class="field-label">Fecha</label><input type="date" id="ce-fecha" value="${todayStr()}"></div>
      <div class="field"><label class="field-label">Hora (opcional)</label><input type="time" id="ce-hora"></div>
    </div>
    <div class="field"><label class="field-label">Responsable</label><input type="text" id="ce-responsable"></div>
    <div class="field"><label class="field-label">Descripción</label><textarea id="ce-desc" rows="3"></textarea></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;"><button class="btn" id="ce-cancel">Cancelar</button><button class="btn primary" id="ce-save">Guardar evento</button></div>`);
  overlay.querySelector("#ce-cancel").addEventListener("click", ()=>overlay.remove());
  overlay.querySelector("#ce-save").addEventListener("click", async ()=>{
    const pid = Number(overlay.querySelector("#ce-proceso").value);
    const titulo = overlay.querySelector("#ce-titulo").value.trim();
    const fecha = overlay.querySelector("#ce-fecha").value || todayStr();
    const hora = overlay.querySelector("#ce-hora").value || "";
    if(!pid){ toast("Selecciona un proceso (radicado)","err"); return; }
    if(!titulo){ toast("El título del evento es obligatorio","err"); return; }
    await DB.add("actuaciones", { processId:pid, titulo, fecha, hora,
      responsable:overlay.querySelector("#ce-responsable").value.trim(), descripcion:overlay.querySelector("#ce-desc").value.trim(), completado:false });
    await logHistorial(pid, `Evento de calendario agregado: ${titulo} (${fmtDate(fecha)}${hora?" "+hora:""})`);
    overlay.remove(); toast("Evento agregado al calendario","ok");
    await refreshAll();
  });
}
document.getElementById("cal-add-event").addEventListener("click", openCalendarEventForm);
document.getElementById("btn-dash-add-event").addEventListener("click", openCalendarEventForm);

/* ============================================================
   11. ESTADÍSTICAS
   ============================================================ */
function renderBarGroup(containerId, counts){
  const max = Math.max(1, ...Object.values(counts));
  const el = document.getElementById(containerId);
  const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  el.innerHTML = entries.length? entries.map(([k,v])=>`
    <div class="bar-row"><div class="lbl" title="${esc(k)}">${esc(k)}</div><div class="bar-track"><div class="bar-fill" style="width:${(v/max*100)}%"></div></div><div class="val">${v}</div></div>`).join("")
    : `<div class="empty-hint">Sin datos aún.</div>`;
}
function renderStats(){
  const ps = STATE.processes;
  const byEstado={}, byAnio={};
  ps.forEach(p=>{
    byEstado[p.estado||"Sin estado"]=(byEstado[p.estado||"Sin estado"]||0)+1;
    if(p.fechaApertura){ const y=new Date(p.fechaApertura+"T00:00:00").getFullYear(); byAnio[y]=(byAnio[y]||0)+1; }
  });
  renderBarGroup("stat-estado", byEstado);
  renderBarGroup("stat-anio", byAnio);
  const archivados = ps.filter(p=>p.estado==="Archivado");
  let avgDays = "—";
  const closedWithDates = archivados.filter(p=>p.fechaApertura);
  if(closedWithDates.length){
    const totalDays = closedWithDates.reduce((s,p)=> s + Math.abs((new Date(p.actualizadoEn||Date.now())-new Date(p.fechaApertura+"T00:00:00"))/86400000), 0);
    avgDays = Math.round(totalDays/closedWithDates.length)+" días";
  }
  document.getElementById("stat-resumen").innerHTML = `
    Total histórico: <b>${ps.length}</b> procesos.<br>
    Activos: <b>${ps.length-archivados.length}</b> · Archivados: <b>${archivados.length}</b>.<br>
    Tiempo promedio estimado hasta archivo: <b>${avgDays}</b>.`;
}

/* ============================================================
   12. BÚSQUEDA GLOBAL / COMMAND PALETTE (Ctrl+K)
   ============================================================ */
const paletteOverlay = document.getElementById("palette-overlay");
const paletteInput = document.getElementById("palette-input");
function openPalette(){ paletteOverlay.classList.add("open"); paletteInput.value=""; paletteInput.focus(); renderPaletteResults(""); }
function closePalette(){ paletteOverlay.classList.remove("open"); }
document.getElementById("btn-open-palette").addEventListener("click", openPalette);
paletteOverlay.addEventListener("click",(e)=>{ if(e.target===paletteOverlay) closePalette(); });
document.addEventListener("keydown",(e)=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="k"){ e.preventDefault(); openPalette(); }
  if(e.key==="Escape"){ closePalette(); closeModal(); }
});
paletteInput.addEventListener("input", ()=> renderPaletteResults(paletteInput.value));
function renderPaletteResults(q){
  q = q.toLowerCase();
  const res = STATE.processes.filter(p=> !q || [p.radicado,p.investigado,p.quejoso,p.observaciones].some(v=>(v||"").toLowerCase().includes(q))).slice(0,20);
  const el = document.getElementById("palette-results");
  el.innerHTML = res.length? res.map(p=>`<div class="pal-item" data-id="${p.id}"><span class="dot-ind ${getOverdueTerms(p).length?'red':'green'}"></span><div><div class="t1">${esc(p.radicado||"(sin radicado)")} · ${esc(p.investigado||"")}</div><div class="t2">${esc(p.estado||"")}</div></div></div>`).join("") : `<div class="empty-hint">Sin coincidencias.</div>`;
  el.querySelectorAll(".pal-item").forEach(it=> it.addEventListener("click",()=>{ closePalette(); openProcessModal(Number(it.dataset.id)); }));
}

/* ============================================================
   13. MODAL DE PROCESO (crear / ver / editar)
   ============================================================ */
const modalOverlay = document.getElementById("modal-overlay");
const modalEl = document.getElementById("process-modal");
function closeModal(){ modalOverlay.classList.remove("open"); modalEl.innerHTML=""; STATE.currentProcessId=null; }
modalOverlay.addEventListener("click",(e)=>{ if(e.target===modalOverlay) closeModal(); });
document.getElementById("btn-new-process").addEventListener("click", ()=> openProcessModal(null));

function emptyProcess(){
  return { radicado:"", investigado:"", quejoso:"", quejosoTipo:"Quejoso",
    fechaApertura: todayStr(), fechaVencimiento:"", estado:ESTADOS[0],
    observaciones:"", prioridad:"Media", terminos:[], favorito:false,
    creadoEn:new Date().toISOString(), actualizadoEn:new Date().toISOString() };
}

async function openProcessModal(id){
  STATE.currentProcessId = id;
  STATE.currentTab = "resumen";
  let p = id ? STATE.processes.find(x=>x.id===id) : emptyProcess();
  await renderProcessModal(p, id);
  modalOverlay.classList.add("open");
}

async function renderProcessModal(p, id){
  const isNew = !id;
  modalEl.innerHTML = `
    <div class="modal-head">
      <h2>${isNew? "Nuevo proceso" : (esc(p.radicado)||"Proceso sin radicado")}</h2>
      ${!isNew?`${estadoBadge(p)}${prioBadge(p.prioridad)}`:""}
      <div class="spacer" style="flex:1"></div>
      ${!isNew?`<button class="btn sm danger" id="btn-delete-process">Eliminar</button>`:""}
      <button class="btn sm ghost close-x" id="btn-close-modal">✕</button>
    </div>
    ${!isNew?`<div class="tabs" id="modal-tabs">
      <div class="tab active" data-tab="resumen">Resumen</div>
      <div class="tab" data-tab="actuaciones">Actuaciones</div>
      <div class="tab" data-tab="documentos">Documentos</div>
      <div class="tab" data-tab="personas">Personas</div>
      <div class="tab" data-tab="terminos">Términos</div>
      <div class="tab" data-tab="tareas">Tareas</div>
      <div class="tab" data-tab="notas">Notas</div>
      <div class="tab" data-tab="historial">Historial</div>
    </div>`:""}
    <div class="modal-body" id="modal-body"></div>`;
  document.getElementById("btn-close-modal").addEventListener("click", closeModal);
  if(!isNew) document.getElementById("btn-delete-process").addEventListener("click", ()=>deleteProcess(id));
  if(!isNew){
    modalEl.querySelectorAll(".tab").forEach(t=> t.addEventListener("click",()=>{
      modalEl.querySelectorAll(".tab").forEach(x=>x.classList.remove("active")); t.classList.add("active");
      STATE.currentTab = t.dataset.tab; renderTabBody(p, id);
    }));
  }
  renderTabBody(p, id);
}

async function renderTabBody(p, id){
  const body = document.getElementById("modal-body");
  const isNew = !id;
  if(isNew || STATE.currentTab==="resumen"){ body.innerHTML = resumenFormHTML(p); bindResumenForm(p, id); return; }
  if(STATE.currentTab==="actuaciones"){ body.innerHTML = `<div id="tl-wrap"></div>`; await renderActuacionesTab(id); return; }
  if(STATE.currentTab==="documentos"){ body.innerHTML = `<div id="doc-wrap"></div>`; await renderDocumentosTab(id); return; }
  if(STATE.currentTab==="personas"){ body.innerHTML = `<div id="per-wrap"></div>`; await renderPersonasTab(id); return; }
  if(STATE.currentTab==="terminos"){ body.innerHTML = `<div id="term-wrap"></div>`; renderTerminosTab(p, id); return; }
  if(STATE.currentTab==="tareas"){ body.innerHTML = `<div id="tareas-wrap"></div>`; await renderTareasTab(id); return; }
  if(STATE.currentTab==="notas"){ body.innerHTML = `<div id="notas-wrap"></div>`; await renderNotasTab(id); return; }
  if(STATE.currentTab==="historial"){ body.innerHTML = `<div id="hist-wrap"></div>`; await renderHistorialTab(id); return; }
}

function resumenFormHTML(p){
  return `
    <div class="grid2">
      <div class="field"><label class="field-label">Radicado</label><input type="text" id="f-radicado" value="${esc(p.radicado)}"></div>
      <div class="field"><label class="field-label">Investigado</label><input type="text" id="f-investigado" value="${esc(p.investigado)}"></div>
      <div class="field">
        <label class="field-label">Quejoso / Informante</label>
        <div style="display:flex;gap:8px;">
          <select id="f-quejosoTipo" style="max-width:150px;flex:0 0 auto;">
            <option value="Quejoso" ${p.quejosoTipo!=="Informante"?"selected":""}>Quejoso</option>
            <option value="Informante" ${p.quejosoTipo==="Informante"?"selected":""}>Informante</option>
          </select>
          <input type="text" id="f-quejoso" value="${esc(p.quejoso)}" placeholder="Nombre">
        </div>
      </div>
      <div class="field"><label class="field-label">Fecha de apertura</label><input type="date" id="f-fechaApertura" value="${p.fechaApertura||""}"></div>
      <div class="field">
        <label class="field-label">Fecha de vencimiento</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="date" id="f-fechaVencimiento" value="${p.fechaVencimiento||""}" style="flex:1;">
          <button type="button" class="btn sm" id="f-venc-3m" title="Sumar 3 meses desde la fecha de apertura (o desde hoy si no hay apertura)">+3 meses</button>
          <button type="button" class="btn sm" id="f-venc-6m" title="Sumar 6 meses desde la fecha de apertura (o desde hoy si no hay apertura)">+6 meses</button>
        </div>
      </div>
      <div class="field"><label class="field-label">Estado</label><select id="f-estado">${ESTADOS.map(e=>`<option ${p.estado===e?"selected":""}>${e}</option>`).join("")}</select>
        ${p.motivoArchivo==="Inhibitorio"&&p.estado==="Archivado"?`<div style="font-size:11px;color:var(--text-muted);margin-top:5px;">⚠️ Archivado automáticamente por Inhibitorio. Cambia el estado a otra opción distinta de "Archivado"/"Inhibitorio" para reactivarlo.</div>`:""}
      </div>
      <div class="field"><label class="field-label">Prioridad</label><select id="f-prioridad">${["Alta","Media","Baja"].map(x=>`<option ${p.prioridad===x?"selected":""}>${x}</option>`).join("")}</select></div>
    </div>
    <div class="field"><label class="field-label">Observaciones</label><textarea id="f-observaciones" rows="4">${esc(p.observaciones)}</textarea></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px;">
      <button class="btn" id="btn-cancel-form">Cancelar</button>
      <button class="btn primary" id="btn-save-process">Guardar proceso</button>
    </div>`;
}
function bindResumenForm(p, id){
  const cancelBtn = document.getElementById("btn-cancel-form");
  if(cancelBtn) cancelBtn.addEventListener("click", closeModal);
  function addMonthsToVencimiento(months){
    const baseStr = document.getElementById("f-fechaApertura").value || todayStr();
    const base = new Date(baseStr+"T00:00:00");
    base.setMonth(base.getMonth()+months);
    document.getElementById("f-fechaVencimiento").value = ymd(base);
  }
  document.getElementById("f-venc-3m").addEventListener("click", ()=>addMonthsToVencimiento(3));
  document.getElementById("f-venc-6m").addEventListener("click", ()=>addMonthsToVencimiento(6));
  document.getElementById("btn-save-process").addEventListener("click", async ()=>{
    const val = k=>document.getElementById("f-"+k).value.trim();
    const updated = {
      ...p, radicado:val("radicado"),
      investigado:val("investigado"), quejoso:val("quejoso"), quejosoTipo:val("quejosoTipo"),
      fechaApertura:val("fechaApertura"), fechaVencimiento:val("fechaVencimiento"), estado:val("estado"),
      prioridad:val("prioridad"),
      observaciones:document.getElementById("f-observaciones").value.trim(),
      actualizadoEn:new Date().toISOString()
    };
    if(!updated.radicado){ toast("Ingresa al menos el radicado","err"); return; }
    let autoArchived = false;
    if(updated.estado==="Inhibitorio"){
      updated.estado = "Archivado";
      updated.motivoArchivo = "Inhibitorio";
      autoArchived = true;
    } else if(updated.motivoArchivo && updated.estado!=="Archivado"){
      // si el proceso cambia de estado manualmente, se limpia el motivo de archivo automático
      updated.motivoArchivo = "";
    }
    if(id){
      await DB.put("processes", updated);
      await logHistorial(id, autoArchived? "Estado marcado como Inhibitorio → proceso archivado automáticamente" : "Información general actualizada");
      toast(autoArchived? "Proceso archivado automáticamente (Inhibitorio)" : "Proceso guardado","ok");
      await refreshAll();
      openProcessModal(id);
    } else {
      const newId = await DB.add("processes", updated);
      await logHistorial(newId, autoArchived? "Proceso creado y archivado automáticamente (Inhibitorio)" : "Proceso creado");
      toast(autoArchived? "Proceso archivado automáticamente (Inhibitorio)" : "Proceso creado","ok");
      await refreshAll();
      openProcessModal(newId);
    }
  });
}
async function deleteProcess(id){
  if(!confirm("¿Eliminar este proceso y toda su información asociada? Esta acción no se puede deshacer.")) return;
  await DB.del("processes", id);
  const stores = ["actuaciones","documentos","personas","historial","notas_items","tareas"];
  for(const s of stores){ const items = await DB.byIndex(s,"processId",id); for(const it of items) await DB.del(s, it.id); }
  // (sin tabla "notas" legada en la nube — las notas viven en notas_items)
  toast("Proceso eliminado","ok");
  closeModal();
  await refreshAll();
}

/* ---- Actuaciones (timeline) ---- */
async function renderActuacionesTab(id){
  const acts = (await DB.byIndex("actuaciones","processId",id)).sort((a,b)=>a.fecha.localeCompare(b.fecha));
  const wrap = document.getElementById("tl-wrap");
  wrap.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:14px;"><button class="btn sm primary" id="btn-add-act">+ Agregar actuación</button></div>
    <div class="timeline">${acts.length? acts.map(a=>{
      const overdue = a.fecha < todayStr() && !a.completado;
      return `<div class="tl-item ${a.completado?'done':(overdue?'overdue':'')}"><div class="tl-dot"></div><div class="tl-card">
        <div class="tl-top"><div class="tl-title">${esc(a.titulo)}</div><div style="display:flex;align-items:center;gap:8px;"><div class="tl-date">${fmtDate(a.fecha)}${a.hora?` · ${esc(a.hora)}`:""}</div><button class="btn sm ghost" data-del-act="${a.id}" title="Eliminar actuación">✕</button></div></div>
        <div class="tl-desc">${esc(a.descripcion||"")}</div>
        <div class="tl-meta"><span>👤 ${esc(a.responsable||"—")}</span>${a.documentoNombre?`<span>📎 ${esc(a.documentoNombre)}</span>`:""}</div>
      </div></div>`;
    }).join("") : `<div class="empty-hint">Aún no hay actuaciones registradas.</div>`}</div>`;
  document.getElementById("btn-add-act").addEventListener("click", ()=> openActuacionForm(id));
  wrap.querySelectorAll("[data-del-act]").forEach(btn=> btn.addEventListener("click", async ()=>{
    if(!confirm("¿Eliminar esta actuación del calendario? Esta acción no se puede deshacer.")) return;
    const actId = Number(btn.dataset.delAct);
    await DB.del("actuaciones", actId);
    await logHistorial(id, "Actuación eliminada del calendario");
    toast("Actuación eliminada","ok");
    await refreshAll();
    await renderActuacionesTab(id);
  }));
}
function openActuacionForm(id){
  const overlay = smallModal("Nueva actuación", `
    <div class="field"><label class="field-label">Título</label><input type="text" id="a-titulo" placeholder="Ej: Auto de pruebas / Declaración"></div>
    <div class="grid2">
      <div class="field"><label class="field-label">Fecha</label><input type="date" id="a-fecha" value="${todayStr()}"></div>
      <div class="field"><label class="field-label">Hora (opcional)</label><input type="time" id="a-hora"></div>
    </div>
    <div class="field"><label class="field-label">Responsable</label><input type="text" id="a-responsable"></div>
    <div class="field"><label class="field-label">Descripción</label><textarea id="a-desc" rows="3"></textarea></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;"><button class="btn" id="a-cancel">Cancelar</button><button class="btn primary" id="a-save">Guardar</button></div>`);
  overlay.querySelector("#a-cancel").addEventListener("click", ()=>overlay.remove());
  overlay.querySelector("#a-save").addEventListener("click", async ()=>{
    const titulo = overlay.querySelector("#a-titulo").value.trim();
    if(!titulo){ toast("El título es obligatorio","err"); return; }
    await DB.add("actuaciones", { processId:id, titulo, fecha:overlay.querySelector("#a-fecha").value||todayStr(),
      hora:overlay.querySelector("#a-hora").value||"",
      responsable:overlay.querySelector("#a-responsable").value.trim(), descripcion:overlay.querySelector("#a-desc").value.trim(), completado:false });
    await logHistorial(id, `Actuación agregada: ${titulo}`);
    overlay.remove(); toast("Actuación agregada","ok");
    await refreshAll(); await renderActuacionesTab(id);
  });
  return overlay;
}
function smallModal(title, bodyHTML){
  const ov = document.createElement("div"); ov.id="modal-overlay"; ov.className="open";
  ov.style.cssText="position:fixed;inset:0;background:rgba(10,12,16,.5);display:flex;align-items:center;justify-content:center;z-index:250;padding:24px;";
  ov.innerHTML = `<div class="modal small"><div class="modal-head"><h2>${esc(title)}</h2><button class="btn sm ghost close-x" id="sm-close">✕</button></div><div class="modal-body">${bodyHTML}</div></div>`;
  document.body.appendChild(ov);
  ov.querySelector("#sm-close").addEventListener("click", ()=>ov.remove());
  ov.addEventListener("click",(e)=>{ if(e.target===ov) ov.remove(); });
  return ov;
}

/* ---- Documentos ---- */
async function renderDocumentosTab(id){
  const docs = await DB.byIndex("documentos","processId",id);
  const wrap = document.getElementById("doc-wrap");
  wrap.innerHTML = `<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
      <select id="doc-folder-select">${FOLDERS.map(f=>`<option>${f}</option>`).join("")}</select>
      <label class="btn sm primary" style="cursor:pointer;">+ Adjuntar archivo<input type="file" id="doc-file-input" class="hidden"></label>
    </div>
    <div id="doc-folders"></div>`;
  document.getElementById("doc-file-input").addEventListener("change", async (e)=>{
    const file = e.target.files[0]; if(!file) return;
    const folder = document.getElementById("doc-folder-select").value;
    const path = `${id}/${Date.now()}_${file.name.replace(/[^\w.\-]+/g,"_")}`;
    toast("Subiendo archivo...","ok");
    const { error: upErr } = await sbClient.storage.from(DOCS_BUCKET).upload(path, file);
    if(upErr){ toast("No se pudo subir el archivo: "+upErr.message,"err"); return; }
    await DB.add("documentos", { processId:id, nombre:file.name, tipo:file.type, tamano:file.size, carpeta:folder, storage_path:path, subidoEn:new Date().toISOString() });
    await logHistorial(id, `Documento adjuntado: ${file.name} (${folder})`);
    toast("Documento adjuntado","ok");
    await renderDocumentosTab(id);
  });
  const foldersEl = document.getElementById("doc-folders");
  foldersEl.innerHTML = FOLDERS.map(f=>{
    const items = docs.filter(d=>d.carpeta===f);
    return `<div class="doc-folder"><h4>📂 ${f} <span style="color:var(--text-muted);font-weight:600;">(${items.length})</span></h4>
      ${items.length? items.map(d=>`<div class="doc-item">
          <span>${docIcon(d)}</span><div class="fn">${esc(d.nombre)}</div><div class="fsz">${(d.tamano/1024).toFixed(1)} KB</div>
          <button class="btn sm ghost" data-view-doc="${d.id}">👁 Ver</button>
          <button class="btn sm ghost" data-open-doc="${d.id}">Abrir</button>
          <button class="btn sm ghost" data-del-doc="${d.id}">✕</button>
        </div>`).join("") : `<div class="empty-hint" style="text-align:left;padding:6px 2px;">Sin documentos.</div>`}
    </div>`;
  }).join("");
  async function getSignedUrl(d){
    const { data, error } = await sbClient.storage.from(DOCS_BUCKET).createSignedUrl(d.storage_path, 3600);
    if(error){ toast("No se pudo generar el enlace del archivo: "+error.message,"err"); return null; }
    return data.signedUrl;
  }
  foldersEl.querySelectorAll("[data-view-doc]").forEach(btn=> btn.addEventListener("click", async ()=>{
    const d = await DB.get("documentos", Number(btn.dataset.viewDoc));
    const url = await getSignedUrl(d);
    if(url) openDocumentViewer(d, url);
  }));
  foldersEl.querySelectorAll("[data-open-doc]").forEach(btn=> btn.addEventListener("click", async ()=>{
    const d = await DB.get("documentos", Number(btn.dataset.openDoc));
    const url = await getSignedUrl(d);
    if(url) window.open(url, "_blank");
  }));
  foldersEl.querySelectorAll("[data-del-doc]").forEach(btn=> btn.addEventListener("click", async ()=>{
    if(!confirm("¿Eliminar este documento?")) return;
    const d = await DB.get("documentos", Number(btn.dataset.delDoc));
    await sbClient.storage.from(DOCS_BUCKET).remove([d.storage_path]);
    await DB.del("documentos", d.id);
    await logHistorial(id, "Documento eliminado");
    await renderDocumentosTab(id);
  }));
}

function docIcon(d){
  const t=(d.tipo||"").toLowerCase(), n=(d.nombre||"").toLowerCase();
  if(t.includes("pdf")||n.endsWith(".pdf")) return "📕";
  if(t.startsWith("image")) return "🖼️";
  if(t.startsWith("audio")) return "🎵";
  if(t.includes("word")||n.endsWith(".doc")||n.endsWith(".docx")) return "📘";
  if(t.includes("sheet")||t.includes("excel")||n.endsWith(".xls")||n.endsWith(".xlsx")) return "📗";
  return "📄";
}

/* ---- Visor interno de documentos ---- */
const docViewerOverlay = document.getElementById("doc-viewer-overlay");
function closeDocViewer(){ docViewerOverlay.classList.remove("open"); document.getElementById("doc-viewer-body").innerHTML=""; }
docViewerOverlay.addEventListener("click",(e)=>{ if(e.target===docViewerOverlay) closeDocViewer(); });
document.getElementById("doc-viewer-close").addEventListener("click", closeDocViewer);

async function openDocumentViewer(d, url){
  document.getElementById("doc-viewer-title").textContent = d.nombre;
  const dl = document.getElementById("doc-viewer-download");
  dl.href = url; dl.download = d.nombre;
  const body = document.getElementById("doc-viewer-body");
  const t = (d.tipo||"").toLowerCase(), n=(d.nombre||"").toLowerCase();
  if(t.includes("pdf") || n.endsWith(".pdf")){
    body.innerHTML = `<iframe src="${url}" style="width:100%;height:100%;border:none;background:#fff;"></iframe>`;
  } else if(t.startsWith("image")){
    body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;overflow:auto;background:var(--surface-2);"><img src="${url}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;"></div>`;
  } else if(t.startsWith("audio")){
    body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:14px;"><div style="font-size:44px;">🎵</div><audio controls src="${url}" style="width:80%;max-width:480px;"></audio></div>`;
  } else if(t.startsWith("video")){
    body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#000;"><video controls src="${url}" style="max-width:100%;max-height:100%;"></video></div>`;
  } else if(t==="text/plain" || n.endsWith(".txt") || n.endsWith(".csv") || n.endsWith(".md")){
    try{
      const text = await fetch(url).then(r=>r.text());
      body.innerHTML = `<pre style="padding:20px;white-space:pre-wrap;font-family:var(--font-mono);font-size:12.5px;height:100%;overflow:auto;margin:0;">${esc(text)}</pre>`;
    }catch(err){
      body.innerHTML = docPreviewUnavailable(d);
      const openBtn = document.getElementById("doc-preview-open-tab");
      if(openBtn) openBtn.addEventListener("click", ()=> window.open(url,"_blank"));
    }
  } else {
    body.innerHTML = docPreviewUnavailable(d);
    const openBtn = document.getElementById("doc-preview-open-tab");
    if(openBtn) openBtn.addEventListener("click", ()=> window.open(url,"_blank"));
  }
  docViewerOverlay.classList.add("open");
}
function docPreviewUnavailable(d){
  return `<div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;text-align:center;padding:20px;">
    <div style="font-size:44px;">${docIcon(d)}</div>
    <div style="font-weight:700;font-size:14px;">${esc(d.nombre)}</div>
    <div style="font-size:12.5px;color:var(--text-muted);max-width:340px;">La vista previa dentro de la app no está disponible para este tipo de archivo (los navegadores no pueden renderizar Word/Excel sin conexión). Ábrelo en una pestaña nueva o descárgalo para verlo con el programa correspondiente.</div>
    <div style="display:flex;gap:8px;">
      <button class="btn sm" id="doc-preview-open-tab">Abrir en pestaña nueva</button>
    </div>
  </div>`;
}

/* ============================================================
   TAREAS PENDIENTES (vista global, todos los procesos)
   ============================================================ */
const globalTasksOverlay = document.getElementById("global-tasks-overlay");
function closeGlobalTasks(){ globalTasksOverlay.classList.remove("open"); }
document.getElementById("global-tasks-close").addEventListener("click", closeGlobalTasks);
globalTasksOverlay.addEventListener("click",(e)=>{ if(e.target===globalTasksOverlay) closeGlobalTasks(); });
document.getElementById("btn-global-tasks").addEventListener("click", openGlobalTasksModal);

async function updateGlobalTasksBadge(){
  const all = await DB.all("tareas");
  const pendientes = all.filter(t=>!t.hecha).length;
  const badge = document.getElementById("global-tasks-count");
  if(badge) badge.textContent = pendientes;
}

async function openGlobalTasksModal(){
  await renderGlobalTasksBody();
  globalTasksOverlay.classList.add("open");
}

async function renderGlobalTasksBody(){
  const body = document.getElementById("global-tasks-body");
  const all = await DB.all("tareas");
  const pendientes = all.filter(t=>!t.hecha);
  await updateGlobalTasksBadge();
  if(!pendientes.length){
    body.innerHTML = `<div class="empty-hint">🎉 No hay tareas pendientes en ningún proceso.</div>`;
    return;
  }
  const grupos = {};
  pendientes.forEach(t=>{ (grupos[t.processId]=grupos[t.processId]||[]).push(t); });
  const processIds = Object.keys(grupos).map(Number).sort((a,b)=>{
    const pa = STATE.processes.find(x=>x.id===a), pb = STATE.processes.find(x=>x.id===b);
    return (pa&&pa.radicado||"").localeCompare(pb&&pb.radicado||"");
  });
  body.innerHTML = processIds.map(pid=>{
    const p = STATE.processes.find(x=>x.id===pid);
    const tareas = grupos[pid].sort((a,b)=>(b.creadoEn||"").localeCompare(a.creadoEn||""));
    return `<div class="gtask-group">
      <div class="gtask-group-head" data-open-proc="${pid}">
        <span class="rad">${esc(p?p.radicado:"(proceso eliminado)")}</span>
        <span class="inv">${esc(p?p.investigado||"":"")}</span>
        <span class="n">${tareas.length}</span>
      </div>
      ${tareas.map(t=>`<div class="task-item">
        <input type="checkbox" data-gtoggle-tarea="${t.id}">
        <div class="tt">${esc(t.titulo)}</div>
        <button class="btn sm ghost" data-gdel-tarea="${t.id}" title="Eliminar tarea">✕</button>
      </div>`).join("")}
    </div>`;
  }).join("");
  body.querySelectorAll("[data-open-proc]").forEach(el=> el.addEventListener("click",()=>{
    closeGlobalTasks();
    openProcessModal(Number(el.dataset.openProc));
  }));
  body.querySelectorAll("[data-gtoggle-tarea]").forEach(chk=> chk.addEventListener("change", async ()=>{
    const tid = Number(chk.dataset.gtoggleTarea);
    const t = await DB.get("tareas", tid);
    t.hecha = true;
    await DB.put("tareas", t);
    await logHistorial(t.processId, `Tarea "${t.titulo}" marcada como hecha`);
    toast("Tarea marcada como hecha","ok");
    await renderGlobalTasksBody();
  }));
  body.querySelectorAll("[data-gdel-tarea]").forEach(btn=> btn.addEventListener("click", async ()=>{
    if(!confirm("¿Eliminar esta tarea?")) return;
    const tid = Number(btn.dataset.gdelTarea);
    const t = await DB.get("tareas", tid);
    await DB.del("tareas", tid);
    await logHistorial(t.processId, "Tarea eliminada");
    await renderGlobalTasksBody();
  }));
}

/* ---- Personas ---- */
async function renderPersonasTab(id){
  const personas = await DB.byIndex("personas","processId",id);
  const wrap = document.getElementById("per-wrap");
  wrap.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:14px;"><button class="btn sm primary" id="btn-add-persona">+ Agregar persona</button></div>
    <div>${personas.length? personas.map(pe=>`<div class="persona-card">
        <div style="display:flex;justify-content:space-between;"><div><div class="role">${esc(pe.rol)}</div><div class="nm">${esc(pe.nombre)}</div></div><button class="btn sm ghost" data-del-per="${pe.id}">✕</button></div>
        <div class="cd">${esc(pe.telefono||"")} ${pe.email?(" · "+esc(pe.email)):""}${pe.documento?(" · CC "+esc(pe.documento)):""}</div>
      </div>`).join("") : `<div class="empty-hint">Sin personas relacionadas.</div>`}</div>`;
  document.getElementById("btn-add-persona").addEventListener("click", ()=>{
    const overlay = smallModal("Agregar persona", `
      <div class="field"><label class="field-label">Rol</label><select id="pe-rol"><option>Investigado</option><option>Quejoso</option><option>Testigo</option><option>Apoderado</option><option>Funcionario</option></select></div>
      <div class="field"><label class="field-label">Nombre completo</label><input type="text" id="pe-nombre"></div>
      <div class="field"><label class="field-label">Documento (CC)</label><input type="text" id="pe-documento"></div>
      <div class="field"><label class="field-label">Teléfono</label><input type="text" id="pe-telefono"></div>
      <div class="field"><label class="field-label">Correo</label><input type="text" id="pe-email"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;"><button class="btn" id="pe-cancel">Cancelar</button><button class="btn primary" id="pe-save">Guardar</button></div>`);
    overlay.querySelector("#pe-cancel").addEventListener("click", ()=>overlay.remove());
    overlay.querySelector("#pe-save").addEventListener("click", async ()=>{
      const nombre = overlay.querySelector("#pe-nombre").value.trim();
      if(!nombre){ toast("El nombre es obligatorio","err"); return; }
      await DB.add("personas",{ processId:id, rol:overlay.querySelector("#pe-rol").value, nombre,
        documento:overlay.querySelector("#pe-documento").value.trim(), telefono:overlay.querySelector("#pe-telefono").value.trim(), email:overlay.querySelector("#pe-email").value.trim() });
      await logHistorial(id, `Persona agregada: ${nombre}`);
      overlay.remove(); toast("Persona agregada","ok");
      await renderPersonasTab(id);
    });
  });
  wrap.querySelectorAll("[data-del-per]").forEach(btn=> btn.addEventListener("click", async ()=>{ await DB.del("personas", Number(btn.dataset.delPer)); await renderPersonasTab(id); }));
}

/* ---- Términos ---- */
function renderTerminosTab(p, id){
  const wrap = document.getElementById("term-wrap");
  const terms = p.terminos||[];
  wrap.innerHTML = `
    <div class="card panel" style="margin-bottom:16px;">
      <div class="section-title">Calculadora de términos (días hábiles, festivos colombianos incluidos)</div>
      <div class="grid3">
        <div class="field"><label class="field-label">Plantilla</label><select id="t-plantilla"><option value="">Personalizado</option>${TERM_PLANTILLAS.map(t=>`<option value="${t.dias}" data-nm="${t.nombre}">${t.nombre} (${t.dias}d)</option>`).join("")}</select></div>
        <div class="field"><label class="field-label">Nombre del término</label><input type="text" id="t-nombre" placeholder="Ej: Descargos"></div>
        <div class="field"><label class="field-label">Fecha inicio</label><input type="date" id="t-inicio" value="${todayStr()}"></div>
        <div class="field"><label class="field-label">Días hábiles</label><input type="number" id="t-dias" value="10" min="1"></div>
        <div class="field"><label class="field-label">Vence el</label><input type="text" id="t-resultado" readonly style="font-weight:700;"></div>
        <div class="field" style="display:flex;align-items:flex-end;"><button class="btn primary" id="t-add" style="width:100%;">+ Agregar término</button></div>
      </div>
    </div>
    <div id="term-list">${terms.length? terms.map((t,i)=>{
      const left = businessDaysBetween(new Date(), new Date(t.fechaVence+"T00:00:00"));
      const overdue = !t.cumplido && t.fechaVence < todayStr();
      return `<div class="term-card"><div class="info"><div class="nm">${esc(t.nombre)} ${t.cumplido?'<span class="badge priority-baja">Cumplido</span>':''}</div><div class="dd">Vence ${fmtDate(t.fechaVence)}</div></div>
        <div class="days-left" style="color:${t.cumplido?'var(--success)':overdue?'var(--danger)':(left<=5?'var(--warning)':'var(--text)')}">${t.cumplido?'✓':(overdue? (Math.abs(left)+'d venc.') : (left+'d'))}</div>
        ${!t.cumplido?`<button class="btn sm" data-done="${i}">Marcar cumplido</button>`:""}
        <button class="btn sm ghost" data-remove="${i}">✕</button></div>`;
    }).join("") : `<div class="empty-hint">Aún no hay términos configurados para este proceso.</div>`}</div>`;

  function recalc(){
    const dias = Number(document.getElementById("t-dias").value||0);
    const start = document.getElementById("t-inicio").value;
    if(!start || !dias){ document.getElementById("t-resultado").value=""; return; }
    const due = addBusinessDays(new Date(start+"T00:00:00"), dias);
    document.getElementById("t-resultado").value = fmtDate(ymd(due));
  }
  document.getElementById("t-dias").addEventListener("input", recalc);
  document.getElementById("t-inicio").addEventListener("input", recalc);
  document.getElementById("t-plantilla").addEventListener("change",(e)=>{
    const opt = e.target.selectedOptions[0];
    if(opt.value){ document.getElementById("t-dias").value = opt.value; document.getElementById("t-nombre").value = opt.dataset.nm; }
    recalc();
  });
  recalc();
  document.getElementById("t-add").addEventListener("click", async ()=>{
    const nombre = document.getElementById("t-nombre").value.trim() || "Término";
    const dias = Number(document.getElementById("t-dias").value||0);
    const start = document.getElementById("t-inicio").value;
    if(!start || !dias){ toast("Completa fecha de inicio y días","err"); return; }
    const due = ymd(addBusinessDays(new Date(start+"T00:00:00"), dias));
    p.terminos = p.terminos||[];
    p.terminos.push({nombre, fechaInicio:start, dias, fechaVence:due, cumplido:false});
    p.actualizadoEn = new Date().toISOString();
    await DB.put("processes", p);
    await logHistorial(id, `Término agregado: ${nombre} (vence ${fmtDate(due)})`);
    toast("Término agregado","ok");
    await refreshAll();
    const fresh = STATE.processes.find(x=>x.id===id);
    renderTerminosTab(fresh, id);
  });
  wrap.querySelectorAll("[data-done]").forEach(btn=> btn.addEventListener("click", async ()=>{
    p.terminos[Number(btn.dataset.done)].cumplido = true;
    await DB.put("processes", p); await refreshAll();
    const fresh = STATE.processes.find(x=>x.id===id); renderTerminosTab(fresh, id);
  }));
  wrap.querySelectorAll("[data-remove]").forEach(btn=> btn.addEventListener("click", async ()=>{
    p.terminos.splice(Number(btn.dataset.remove),1);
    await DB.put("processes", p); await refreshAll();
    const fresh = STATE.processes.find(x=>x.id===id); renderTerminosTab(fresh, id);
  }));
}

/* ---- Tareas ---- */
async function renderTareasTab(id){
  const wrap = document.getElementById("tareas-wrap");
  const tareas = (await DB.byIndex("tareas","processId",id)).sort((a,b)=>{
    if(a.hecha!==b.hecha) return a.hecha?1:-1;
    return (b.creadoEn||"").localeCompare(a.creadoEn||"");
  });
  const pendientes = tareas.filter(t=>!t.hecha);
  const hechas = tareas.filter(t=>t.hecha);
  function taskRow(t){
    return `<div class="task-item ${t.hecha?'done':''}">
      <input type="checkbox" data-toggle-tarea="${t.id}" ${t.hecha?"checked":""}>
      <div class="tt">${esc(t.titulo)}</div>
      <button class="btn sm ghost" data-del-tarea="${t.id}" title="Eliminar tarea">✕</button>
    </div>`;
  }
  wrap.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <input type="text" id="tarea-nueva" placeholder="Escribe una nueva tarea y presiona Enter..." style="flex:1;">
      <button class="btn primary" id="btn-add-tarea">+ Agregar tarea</button>
    </div>
    <div class="section-title">Pendientes <span class="cnt">${pendientes.length}</span></div>
    <div id="tareas-pendientes" style="margin-bottom:20px;">${pendientes.length? pendientes.map(taskRow).join("") : `<div class="empty-hint">Sin tareas pendientes.</div>`}</div>
    ${hechas.length? `<div class="section-title">Hechas <span class="cnt">${hechas.length}</span></div>
    <div id="tareas-hechas">${hechas.map(taskRow).join("")}</div>` : ""}`;

  async function addTarea(){
    const input = document.getElementById("tarea-nueva");
    const titulo = input.value.trim();
    if(!titulo){ toast("Escribe el texto de la tarea","err"); return; }
    await DB.add("tareas", { processId:id, titulo, hecha:false, creadoEn:new Date().toISOString() });
    await logHistorial(id, `Tarea agregada: ${titulo}`);
    await renderTareasTab(id);
  }
  document.getElementById("btn-add-tarea").addEventListener("click", addTarea);
  document.getElementById("tarea-nueva").addEventListener("keydown",(e)=>{ if(e.key==="Enter"){ e.preventDefault(); addTarea(); } });

  wrap.querySelectorAll("[data-toggle-tarea]").forEach(chk=> chk.addEventListener("change", async ()=>{
    const tid = Number(chk.dataset.toggleTarea);
    const t = await DB.get("tareas", tid);
    t.hecha = chk.checked;
    await DB.put("tareas", t);
    await logHistorial(id, `Tarea "${t.titulo}" marcada como ${t.hecha?"hecha":"pendiente"}`);
    await renderTareasTab(id);
  }));
  wrap.querySelectorAll("[data-del-tarea]").forEach(btn=> btn.addEventListener("click", async ()=>{
    if(!confirm("¿Eliminar esta tarea?")) return;
    const tid = Number(btn.dataset.delTarea);
    await DB.del("tareas", tid);
    await logHistorial(id, "Tarea eliminada");
    await renderTareasTab(id);
  }));
}

/* ---- Notas (markdown ligero) ---- */
function mdToHtml(md){
  return esc(md)
    .replace(/^### (.*)$/gm,"<h4>$1</h4>").replace(/^## (.*)$/gm,"<h3>$1</h3>").replace(/^# (.*)$/gm,"<h2>$1</h2>")
    .replace(/\*\*(.+?)\*\*/g,"<b>$1</b>").replace(/\*(.+?)\*/g,"<i>$1</i>")
    .replace(/`([^`]+)`/g,"<code>$1</code>")
    .replace(/^- \[ \] (.*)$/gm,"<div>☐ $1</div>").replace(/^- \[x\] (.*)$/gm,"<div>☑ $1</div>")
    .replace(/^- (.*)$/gm,"<div>• $1</div>")
    .replace(/\n/g,"<br>");
}
async function renderNotasTab(id){
  const wrap = document.getElementById("notas-wrap");
  const notas = (await DB.byIndex("notas_items","processId",id)).sort((a,b)=> b.fecha.localeCompare(a.fecha));
  wrap.innerHTML = `
    <div class="card panel" style="margin-bottom:16px;">
      <div class="toolbar"><div class="section-title" style="margin:0;">Nueva nota</div><div class="flexgrow"></div><span style="font-size:11.5px;color:var(--text-muted);">Soporta **negrita**, *cursiva*, \`código\`, listas y checklists \`- [ ]\`</span></div>
      <textarea class="notes-area" id="notas-area" placeholder="Escribe una nueva nota del expediente..." style="min-height:110px;"></textarea>
      <div style="display:flex;justify-content:flex-end;margin-top:10px;"><button class="btn primary" id="notas-save">+ Añadir nota</button></div>
    </div>
    <div id="notas-list">${notas.length? notas.map(n=>`
      <div class="card panel" style="margin-bottom:12px;" data-nota-card="${n.id}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-size:11.5px;color:var(--text-muted);font-weight:700;">${new Date(n.fecha).toLocaleString("es-CO")}${n.editadoEn?` <span style="font-style:italic;">(editada)</span>`:""}</span>
          <div style="display:flex;gap:4px;">
            <button class="btn sm ghost" data-edit-nota="${n.id}" title="Editar nota">✎ Editar</button>
            <button class="btn sm ghost" data-del-nota="${n.id}" title="Eliminar nota">✕</button>
          </div>
        </div>
        <div class="nota-view" style="font-size:13px;line-height:1.7;">${mdToHtml(n.content)}</div>
      </div>`).join("") : `<div class="empty-hint">Aún no hay notas. Escribe la primera arriba.</div>`}
    </div>`;
  document.getElementById("notas-save").addEventListener("click", async ()=>{
    const content = document.getElementById("notas-area").value.trim();
    if(!content){ toast("Escribe algo antes de guardar la nota","err"); return; }
    await DB.add("notas_items", {processId:id, content, fecha:new Date().toISOString()});
    await logHistorial(id, "Nota agregada");
    toast("Nota agregada","ok");
    await renderNotasTab(id);
  });
  wrap.querySelectorAll("[data-del-nota]").forEach(btn=> btn.addEventListener("click", async ()=>{
    if(!confirm("¿Eliminar esta nota?")) return;
    await DB.del("notas_items", Number(btn.dataset.delNota));
    await logHistorial(id, "Nota eliminada");
    await renderNotasTab(id);
  }));
  wrap.querySelectorAll("[data-edit-nota]").forEach(btn=> btn.addEventListener("click", async ()=>{
    const notaId = Number(btn.dataset.editNota);
    const card = wrap.querySelector(`[data-nota-card="${notaId}"]`);
    const nota = notas.find(n=>n.id===notaId);
    const viewDiv = card.querySelector(".nota-view");
    viewDiv.innerHTML = `
      <textarea class="notes-area" style="min-height:100px;">${esc(nota.content)}</textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
        <button class="btn sm" data-cancel-edit-nota="${notaId}">Cancelar</button>
        <button class="btn sm primary" data-save-edit-nota="${notaId}">Guardar cambios</button>
      </div>`;
    viewDiv.querySelector(`[data-cancel-edit-nota]`).addEventListener("click", ()=> renderNotasTab(id));
    viewDiv.querySelector(`[data-save-edit-nota]`).addEventListener("click", async ()=>{
      const newContent = viewDiv.querySelector("textarea").value.trim();
      if(!newContent){ toast("La nota no puede quedar vacía","err"); return; }
      nota.content = newContent;
      nota.editadoEn = new Date().toISOString();
      await DB.put("notas_items", nota);
      await logHistorial(id, "Nota editada");
      toast("Nota actualizada","ok");
      await renderNotasTab(id);
    });
  }));
}

/* ---- Historial ---- */
async function renderHistorialTab(id){
  const hist = (await DB.byIndex("historial","processId",id)).sort((a,b)=>b.fecha.localeCompare(a.fecha));
  document.getElementById("hist-wrap").innerHTML = hist.length? hist.map(h=>`
    <div class="hist-row"><div class="when">${new Date(h.fecha).toLocaleString("es-CO")}</div><div>${esc(h.cambio)} <span style="color:var(--text-muted);">— ${esc(h.usuario)}</span></div></div>`).join("")
    : `<div class="empty-hint">Sin historial todavía.</div>`;
}

/* ============================================================
   14. BACKUP / RESTORE
   ============================================================ */
document.getElementById("btn-backup").addEventListener("click", async ()=>{
  const data = {};
  for(const s of ["processes","actuaciones","documentos","personas","notas_items","tareas","historial","meta"]) data[s] = await DB.all(s);
  const json = JSON.stringify({exportedAt:new Date().toISOString(), version:"cloud-v1", data});
  downloadBlob(json, "application/json", `ocid_procesos_backup_${todayStr()}.json`);
  toast("Copia de seguridad descargada (solo lectura, no restaurable desde aquí)","ok");
});
document.getElementById("btn-restore").addEventListener("click", ()=>{
  toast("En la versión en la nube, 'Restaurar' no está disponible: podría corromper los datos compartidos del equipo. Usa 'Backup' solo como copia de seguridad de lectura.","err");
});

/* ============================================================
   14b. ALERTAS POR WHATSAPP (CallMeBot) — requiere internet
   ------------------------------------------------------------
   CallMeBot es un servicio gratuito de terceros (no de Anthropic).
   Envía un WhatsApp automático cuando a un proceso le faltan
   exactamente 7 días para su fecha de vencimiento (general o de
   un término manual). Solo funciona mientras el navegador tenga
   esta pestaña abierta y con conexión a internet en ese momento;
   el resto de la app sigue funcionando 100% offline.
   ============================================================ */
function buildCallMeBotUrl(cfg, text){
  let phone = (cfg.phone||"").replace(/[^\d+]/g,"");
  if(!phone.startsWith("+")) phone = "+57"+phone.replace(/^0+/,""); // Colombia por defecto
  return `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(cfg.apikey)}`;
}
function sendWhatsappMessage(cfg, text){
  // Envío "silencioso" (fire-and-forget) vía pixel de imagen para evitar bloqueos CORS
  // desde JavaScript en el navegador. No se puede leer la respuesta, pero la petición sí sale.
  try{
    const url = buildCallMeBotUrl(cfg, text);
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.src = url;
  }catch(err){ console.error("Error enviando WhatsApp:", err); }
}
async function getWhatsappConfig(){
  const rec = await DB.get("meta","whatsappConfig").catch(()=>null);
  return rec ? rec.value : null;
}
function calendarDaysLeft(dateStr){
  if(!dateStr) return null;
  const due = new Date(dateStr+"T00:00:00");
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.round((due-today)/86400000);
}
const WA_THRESHOLDS = [7,3];      // días antes del vencimiento en que se avisa
const WA_CATCHUP_LIMIT = -30;      // no reenviar alertas "atrasadas" de procesos vencidos hace más de 30 días

async function checkWhatsappAlerts(){
  const cfg = await getWhatsappConfig();
  if(!cfg || !cfg.enabled || !cfg.apikey || !cfg.phone) return;
  for(const p of STATE.processes){
    if(p.estado==="Archivado") continue;
    let changed = false;

    // Vencimiento general del proceso
    if(p.fechaVencimiento){
      const dl = calendarDaysLeft(p.fechaVencimiento);
      p._waSent = p._waSent || {};
      const sentList = p._waSent[p.fechaVencimiento] = p._waSent[p.fechaVencimiento] || [];
      for(const th of WA_THRESHOLDS){
        if(dl!==null && dl<=th && dl>=WA_CATCHUP_LIMIT && !sentList.includes(th)){
          const diasTxt = dl<0 ? `vencido hace ${Math.abs(dl)} día(s)` : (dl===0? "vence hoy" : `vence en ${dl} día(s)`);
          sendWhatsappMessage(cfg, `⚠️ OCID PROCESOS\nProceso: ${p.radicado||"(sin radicado)"}\n${diasTxt}: ${fmtDate(p.fechaVencimiento)}`);
          sentList.push(th); changed = true;
        }
      }
    }

    // Términos manuales (pestaña Términos)
    (p.terminos||[]).forEach(t=>{
      if(t.cumplido || !t.fechaVence) return;
      const dl = calendarDaysLeft(t.fechaVence);
      t._waSent = t._waSent || {};
      const sentList = t._waSent[t.fechaVence] = t._waSent[t.fechaVence] || [];
      WA_THRESHOLDS.forEach(th=>{
        if(dl!==null && dl<=th && dl>=WA_CATCHUP_LIMIT && !sentList.includes(th)){
          const diasTxt = dl<0 ? `vencido hace ${Math.abs(dl)} día(s)` : (dl===0? "vence hoy" : `vence en ${dl} día(s)`);
          sendWhatsappMessage(cfg, `⚠️ OCID PROCESOS\nProceso: ${p.radicado||"(sin radicado)"}\nTérmino "${t.nombre}" — ${diasTxt}: ${fmtDate(t.fechaVence)}`);
          sentList.push(th); changed = true;
        }
      });
    });

    if(changed) await DB.put("processes", p);
  }
}
document.getElementById("btn-whatsapp-config").addEventListener("click", async ()=>{
  const cfg = (await getWhatsappConfig()) || {phone:"3158501046", apikey:"", enabled:false};
  const overlay = smallModal("Alertas por WhatsApp (CallMeBot)", `
    <div style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:14px;">
      Envía un WhatsApp automático cuando falten <b>7 días</b> para el vencimiento de un proceso o término.
      Requiere internet en el momento del envío y una <b>API key gratuita de CallMeBot</b> (no la genera esta app).<br><br>
      <b>Cómo obtener tu API key:</b><br>
      1. Guarda el contacto <b>+34 694 29 84 96</b> en tu WhatsApp.<br>
      2. Desde tu número, envíale el mensaje: <i>"I allow callmebot to send me messages"</i>.<br>
      3. Te responderá con tu API key — cópiala aquí abajo.
    </div>
    <div class="field"><label class="field-label">Tu número de WhatsApp</label><input type="text" id="wa-phone" value="${esc(cfg.phone)}" placeholder="3158501046"></div>
    <div class="field"><label class="field-label">API key de CallMeBot</label><input type="text" id="wa-apikey" value="${esc(cfg.apikey)}" placeholder="Ej: 123456"></div>
    <div class="field" style="display:flex;align-items:center;gap:8px;">
      <input type="checkbox" id="wa-enabled" style="width:auto;" ${cfg.enabled?"checked":""}>
      <label for="wa-enabled" style="font-size:13px;">Activar envío automático de alertas</label>
    </div>
    <div style="display:flex;justify-content:space-between;gap:8px;margin-top:6px;">
      <button class="btn sm" id="wa-test">Enviar mensaje de prueba</button>
      <div style="display:flex;gap:8px;">
        <button class="btn" id="wa-cancel">Cancelar</button>
        <button class="btn primary" id="wa-save">Guardar</button>
      </div>
    </div>`);
  overlay.querySelector("#wa-cancel").addEventListener("click", ()=>overlay.remove());
  overlay.querySelector("#wa-test").addEventListener("click", ()=>{
    const phone = overlay.querySelector("#wa-phone").value.trim();
    const apikey = overlay.querySelector("#wa-apikey").value.trim();
    if(!phone || !apikey){ toast("Ingresa el número y la API key primero","err"); return; }
    const url = buildCallMeBotUrl({phone,apikey}, "✅ Prueba desde OCID PROCESOS: la conexión con CallMeBot funciona correctamente.");
    window.open(url, "_blank");
    toast("Prueba enviada, revisa tu WhatsApp","ok");
  });
  overlay.querySelector("#wa-save").addEventListener("click", async ()=>{
    const phone = overlay.querySelector("#wa-phone").value.trim();
    const apikey = overlay.querySelector("#wa-apikey").value.trim();
    const enabled = overlay.querySelector("#wa-enabled").checked;
    if(enabled && (!phone || !apikey)){ toast("Para activar necesitas número y API key","err"); return; }
    await DB.put("meta", {key:"whatsappConfig", value:{phone, apikey, enabled}});
    toast("Configuración de WhatsApp guardada","ok");
    overlay.remove();
    await checkWhatsappAlerts();
  });
});


/* ============================================================
   15. EXPORTACIONES (resumen ejecutivo, CSV global)
   ============================================================ */
document.getElementById("btn-export-exec").addEventListener("click", ()=>{
  const ps = STATE.processes;
  const archivados = ps.filter(p=>p.estado==="Archivado").length;
  let txt = `RESUMEN EJECUTIVO — LEXTRACKER\nGenerado: ${new Date().toLocaleString("es-CO")}\n\n`;
  txt += `Total de procesos: ${ps.length}\nActivos: ${ps.length-archivados}\nArchivados: ${archivados}\n\n`;
  txt += `PROCESOS CON TÉRMINOS VENCIDOS:\n`;
  ps.forEach(p=>{ getOverdueTerms(p).forEach(t=> txt+= ` - ${p.radicado||"(sin radicado)"} | ${t.nombre} | venció ${fmtDate(t.fechaVence)}\n`); });
  txt += `\nPROCESOS POR ESTADO:\n`;
  const byEstado={}; ps.forEach(p=> byEstado[p.estado]=(byEstado[p.estado]||0)+1);
  Object.entries(byEstado).forEach(([k,v])=> txt += ` - ${k}: ${v}\n`);
  downloadBlob(txt,"text/plain;charset=utf-8",`lextracker_resumen_${todayStr()}.txt`);
  toast("Resumen ejecutivo descargado","ok");
});

/* ============================================================
   16. INIT
   ============================================================ */
async function init(){
  const { data: { session } } = await sbClient.auth.getSession();
  if(!session){
    showLogin();
  } else {
    document.getElementById("sb-user-email").textContent = session.user.email;
    const themeMeta = await DB.get("meta","theme").catch(()=>null);
    if(themeMeta && themeMeta.value==="dark"){ document.documentElement.setAttribute("data-theme","dark"); document.getElementById("theme-toggle").querySelector(".dot").textContent="☀"; }
    wireRealtimeSync();
    await refreshAll();
  }
  // Revisa alertas de WhatsApp cada 30 minutos mientras la pestaña permanezca abierta,
  // para detectar el cambio de día sin depender de que el usuario guarde algo.
  setInterval(()=>{ if(!loginOverlay.classList.contains("open")) checkWhatsappAlerts(); }, 30*60*1000);

  sbClient.auth.onAuthStateChange((event)=>{
    if(event==="SIGNED_OUT") location.reload();
  });
}
init();

})();
