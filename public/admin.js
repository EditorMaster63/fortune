const loginCard = document.getElementById("loginCard");
const panelCard = document.getElementById("panelCard");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const loginMsg = document.getElementById("loginMsg");
const userEl = document.getElementById("user");
const passEl = document.getElementById("pass");
const slotsEl = document.getElementById("slots");
const publishBtn = document.getElementById("publishBtn");
const clearBtn = document.getElementById("clearBtn");
const roundInfo = document.getElementById("roundInfo");

function pad(n){ return String(n).padStart(2,"0"); }
function formatMs(ms){
  const s = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const sec = s%60;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

async function api(path, options){
  const r = await fetch(path, options);
  const j = await r.json().catch(() => null);
  return { r, j };
}

async function check(){
  const { j } = await api("/api/admin/status");
  if(j && j.ok && j.isAdmin){
    loginCard.style.display = "none";
    panelCard.style.display = "block";
    logoutBtn.style.display = "inline-flex";
    await refresh();
  }else{
    loginCard.style.display = "block";
    panelCard.style.display = "none";
    logoutBtn.style.display = "none";
  }
}

async function login(){
  loginMsg.textContent = "Проверяю...";
  const { r, j } = await api("/api/admin/login", {
    method:"POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ user: userEl.value.trim(), pass: passEl.value })
  });
  if(j && j.ok){
    loginMsg.textContent = "Ок!";
    await check();
  }else{
    loginMsg.textContent = "Неверный логин/пароль";
  }
}

async function logout(){
  await api("/api/admin/logout", { method:"POST" });
  await check();
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[s]));
}

function renderRound(round){
  if(!round){
    roundInfo.textContent = "нет активного";
    return;
  }
  const msLeft = round.expires_at ? (round.expires_at - Date.now()) : 0;
  roundInfo.textContent = `активен, осталось ~${formatMs(msLeft)}`;
}

function renderSlots(slots){
  slotsEl.innerHTML = "";
  slots.forEach(s => {
    const row = document.createElement("div");
    row.className = "card";
    row.style.marginBottom = "12px";
    row.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:center;">
        <div>
          <div style="font-weight:900;">Ячейка ${s.slotIndex+1}</div>
          <div class="small">Текущее: <span class="mono">${escapeHtml(s.name || "— пусто")}</span></div>
          <div class="small">Состояние: <b>${s.hasVideo ? (s.claimed ? "❌ уже выиграно" : "✅ доступно") : "— пусто"}</b></div>
        </div>
        <form data-slot="${s.slotIndex}" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <input type="file" name="video" accept="video/*" required
            style="padding:10px; border-radius:12px; border:1px solid rgba(255,255,255,.12); background:rgba(0,0,0,.18); color:var(--text);" />
          <button class="btn" type="submit">Загрузить</button>
        </form>
      </div>
    `;
    slotsEl.appendChild(row);
  });

  slotsEl.querySelectorAll("form").forEach(f => {
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const slot = f.getAttribute("data-slot");
      const fd = new FormData(f);
      const btn = f.querySelector("button");
      btn.disabled = true;
      btn.textContent = "Загрузка...";
      const r = await fetch(`/api/admin/upload/${slot}`, { method:"POST", body: fd });
      const j = await r.json().catch(()=>null);
      btn.disabled = false;
      btn.textContent = "Загрузить";
      if(j && j.ok){
        await refresh();
      }else{
        alert("Ошибка загрузки");
      }
      f.reset();
    });
  });
}

async function refresh(){
  const r = await fetch("/api/admin/slots");
  if(!r.ok){
    return;
  }
  const j = await r.json().catch(()=>null);
  if(!j || !j.ok) return;
  renderSlots(j.slots);
  // round info for admin: use /api/state to get expiresAt (simpler)
  const st = await (await fetch("/api/state")).json();
  if(st && st.ok && st.round){
    roundInfo.textContent = `активен, осталось ~${formatMs(st.round.expiresAt - Date.now())}`;
  }else{
    roundInfo.textContent = "нет активного";
  }
}

async function publish(){
  if(!confirm("Опубликовать новый раунд на 24 часа? Очередь и прошлые токены сбросятся.")) return;
  const { r, j } = await api("/api/admin/publish", { method:"POST" });
  if(j && j.ok){
    alert("Раунд опубликован!");
    await refresh();
  }else{
    alert("Не получилось. Проверь, что загружено хотя бы одно видео.");
  }
}

async function clearAll(){
  if(!confirm("Точно очистить всё? Видео удалятся, раунд остановится.")) return;
  const { j } = await api("/api/admin/clear", { method:"POST" });
  if(j && j.ok){
    alert("Очищено.");
    await refresh();
  }else{
    alert("Ошибка.");
  }
}

loginBtn.addEventListener("click", login);
logoutBtn.addEventListener("click", logout);
publishBtn.addEventListener("click", publish);
clearBtn.addEventListener("click", clearAll);

// keep admin timer updated
setInterval(async () => {
  if(panelCard.style.display === "block"){
    const st = await (await fetch("/api/state")).json().catch(()=>null);
    if(st && st.ok && st.round){
      roundInfo.textContent = `активен, осталось ~${formatMs(st.round.expiresAt - Date.now())}`;
    }else{
      roundInfo.textContent = "нет активного";
    }
  }
}, 1500);

check();
