const socket = io();

const wheelEl = document.getElementById("wheel");
const labelsEl = document.getElementById("labels");
const startBtn = document.getElementById("startBtn");
const statusText = document.getElementById("statusText");
const myPosEl = document.getElementById("myPos");
const roundStateEl = document.getElementById("roundState");
const timerEl = document.getElementById("timer");
const queueSizeEl = document.getElementById("queueSize");
const slotListEl = document.getElementById("slotList");

const modalBack = document.getElementById("modalBack");
const closeModal = document.getElementById("closeModal");
const watchLink = document.getElementById("watchLink");
const downloadLink = document.getElementById("downloadLink");
const modalTitle = document.getElementById("modalTitle");
const modalDesc = document.getElementById("modalDesc");

let state = null;
let spinning = false;
let spinBaseDeg = 0;

function pad(n){ return String(n).padStart(2,"0"); }

function formatMs(ms){
  const s = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const sec = s%60;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function setStatus(text){ statusText.textContent = text; }

function renderSlots(slots){
  // list
  slotListEl.innerHTML = slots.map(s => {
    const label = s.hasVideo ? (s.claimed ? "❌ занято" : "✅ доступно") : "— пусто";
    const name = s.name ? s.name : "Без названия";
    return `<div style="display:flex; justify-content:space-between; gap:10px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,.08)">
      <div><b>Ячейка ${s.slotIndex+1}</b> — <span class="mono">${escapeHtml(name)}</span></div>
      <div>${label}</div>
    </div>`;
  }).join("");
}

function renderWheelLabels(slots){
  labelsEl.innerHTML = "";
  const n = 5;
  const sector = 360 / n;
  for(let i=0;i<n;i++){
    const s = slots[i];
    const txt = s && s.hasVideo ? (s.claimed ? "занято" : (s.name || `Видео ${i+1}`)) : "пусто";
    const label = document.createElement("div");
    label.className = "label";
    // position: rotate by (i*sector + sector/2) and move outward
    const angle = i*sector + sector/2;
    label.style.transform = `translate(-50%,-50%) rotate(${angle}deg) translate(110px) rotate(0deg)`;
    label.textContent = `#${i+1}: ${txt}`;
    labelsEl.appendChild(label);
  }
}

function updateRoundUI(round){
  if(!round){
    roundStateEl.textContent = "нет";
    timerEl.textContent = "--:--:--";
    return;
  }
  roundStateEl.textContent = "активен";
  // timer updated by tick
}

function tick(){
  if(!state || !state.round){
    timerEl.textContent = "--:--:--";
    return;
  }
  const msLeft = state.round.expiresAt - Date.now();
  timerEl.textContent = formatMs(msLeft);
  if(msLeft <= 0){
    // let server push refresh anyway
    setStatus("раунд закончился");
  }
}

setInterval(tick, 250);

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[s]));
}

async function fetchState(){
  const r = await fetch("/api/state");
  const j = await r.json();
  if(j.ok){
    state = j;
    queueSizeEl.textContent = j.queue ?? 0;
    updateRoundUI(j.round);
    renderSlots(j.slots);
    renderWheelLabels(j.slots);
  }
}

socket.on("state", (s) => {
  state = { ok:true, ...s };
  queueSizeEl.textContent = s.queue ?? 0;
  updateRoundUI(s.round);
  renderSlots(s.slots);
  renderWheelLabels(s.slots);
});

function openPrizeModal(name, token){
  modalTitle.textContent = "🎁 Твой приз!";
  modalDesc.innerHTML = `Видео: <b class="mono">${escapeHtml(name)}</b>`;
  watchLink.href = `/watch/${token}`;
  downloadLink.href = `/download/${token}`;
  modalBack.classList.add("show");
}

closeModal.addEventListener("click", () => modalBack.classList.remove("show"));
modalBack.addEventListener("click", (e) => { if(e.target === modalBack) modalBack.classList.remove("show"); });

function animateToSlot(slotIndex){
  const n = 5;
  const sector = 360 / n;
  // Pointer at top (0deg). We want selected sector center at top.
  const targetCenter = slotIndex*sector + sector/2;
  // We rotate wheel so that targetCenter goes to 0deg (top), meaning rotate by -targetCenter
  // Add extra spins for drama:
  const extraSpins = 5;
  const jitter = (Math.random()*0.6 - 0.3) * (sector*0.7);
  const deg = -(targetCenter + jitter) + extraSpins*360;
  spinBaseDeg += deg;
  wheelEl.style.transform = `rotate(${spinBaseDeg}deg)`;
}

async function spin(){
  if(spinning) return;
  spinning = true;
  setStatus("запрос...");
  myPosEl.textContent = "—";

  try{
    const r = await fetch("/api/spin", { method:"POST" });
    const j = await r.json();

    if(!j.ok){
      setStatus("ошибка/нет раунда");
      spinning = false;
      return;
    }

    if(j.status === "queued"){
      myPosEl.textContent = String(j.position);
      setStatus("в очереди");
      spinning = false;
      return;
    }

    if(j.status === "ok"){
      myPosEl.textContent = "1";
      setStatus("крутим...");
      animateToSlot(j.slotIndex);

      // show after animation
      setTimeout(() => {
        setStatus("готово");
        openPrizeModal(j.name, j.token);
        spinning = false;
      }, 6200);

      return;
    }

    setStatus("неизвестно");
    spinning = false;
  }catch(e){
    console.error(e);
    setStatus("ошибка сети");
    spinning = false;
  }
}

startBtn.addEventListener("click", spin);

fetchState();
