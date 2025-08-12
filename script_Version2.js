// BeatBot de Cumpleaños - Mejoras de accesibilidad y organización
(() => {
  /* ---------- Parche universal de audio (iOS / iframes) ---------- */
  let ctx, master, audioUnlocked = false;
  function ensureAudio() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = parseFloat(document.getElementById('vol').value || 0.9);
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  }
  function unlockAudioOnce() {
    if (audioUnlocked) return;
    ensureAudio();
    audioUnlocked = true;
    document.removeEventListener('touchstart', unlockAudioOnce, {passive:true});
    document.removeEventListener('pointerdown', unlockAudioOnce);
    document.removeEventListener('keydown', unlockAudioOnce);
  }
  document.addEventListener('touchstart', unlockAudioOnce, {passive:true});
  document.addEventListener('pointerdown', unlockAudioOnce);
  document.addEventListener('keydown', unlockAudioOnce);

  /* --------------------- Estado del secuenciador --------------------- */
  const lookahead = 25, scheduleAhead = 0.12;
  let playing = false, current16th = 0, nextNoteTime = 0, timerID = null, melodyTimer = null;

  const $ = s => document.querySelector(s);
  const sequencerEl = $('#sequencer');
  const bpmEl = $('#bpm'), bpmvEl = $('#bpmv');
  const volEl = $('#vol'), patternEl = $('#pattern');
  const melodyToggle = $('#melodyToggle'), ttsToggle = $('#ttsToggle');

  bpmEl.addEventListener('input', () => bpmvEl.textContent = bpmEl.value);
  volEl.addEventListener('input', () => { if (master) master.gain.value = parseFloat(volEl.value); });

  /* --------------------------- Sintetizadores ------------------------ */
  function makeKick(time){
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type='sine';
    o.frequency.setValueAtTime(150,time);
    o.frequency.exponentialRampToValueAtTime(45,time+0.12);
    g.gain.setValueAtTime(1,time);
    g.gain.exponentialRampToValueAtTime(0.001,time+0.18);
    o.connect(g).connect(master); o.start(time); o.stop(time+0.2);
  }
  function makeSnare(time){
    const len = 0.12, bufferSize = 2*ctx.sampleRate*len;
    const nb = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const d = nb.getChannelData(0); for (let i=0;i<bufferSize;i++) d[i]=Math.random()*2-1;
    const n = ctx.createBufferSource(); n.buffer = nb;
    const bp = ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1800; bp.Q.value=0.6;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.8,time); g.gain.exponentialRampToValueAtTime(0.001,time+len);
    n.connect(bp).connect(g).connect(master); n.start(time); n.stop(time+len);
  }
  function makeHat(time, closed=true){
    const len = closed?0.05:0.2, bufferSize = 2*ctx.sampleRate*len;
    const nb = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const d = nb.getChannelData(0); for (let i=0;i<bufferSize;i++) d[i]=Math.random()*2-1;
    const n = ctx.createBufferSource(); n.buffer = nb;
    const hp = ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=7000;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.5,time); g.gain.exponentialRampToValueAtTime(0.001,time+len);
    n.connect(hp).connect(g).connect(master); n.start(time); n.stop(time+len);
  }
  function beep(time, freq, dur=0.3){
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type='square'; o.frequency.setValueAtTime(freq,time);
    g.gain.setValueAtTime(0.001,time); g.gain.linearRampToValueAtTime(0.25,time+0.01);
    g.gain.exponentialRampToValueAtTime(0.001,time+dur);
    o.connect(g).connect(master); o.start(time); o.stop(time+dur+0.05);
  }

  /* ---------------------------- Patrones ----------------------------- */
  const emptyRow = () => Array(16).fill(false);
  const kit = { kick: emptyRow(), snare: emptyRow(), hat: emptyRow() };
  const patterns = {
    party:  { kick:[1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0],
              snare:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],
              hat:[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1] },
    dembow: { kick:[1,0,0,1,0,0,1,0,1,0,0,1,0,0,1,0],
              snare:[0,0,1,0,0,1,0,0,0,0,1,0,0,1,0,0],
              hat:[1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0] },
    four:   { kick:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0],
              snare:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],
              hat:[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1] }
  };
  function loadPattern(name){
    ['kick','snare','hat'].forEach(r => { kit[r] = patterns[name][r].map(v=>!!v); });
    renderGrid();
  }

  /* ---------------------- Melodía "Cumpleaños" ---------------------- */
  const A4=440, n = s => A4*Math.pow(2,s/12);
  const NOTES = { C4:n(-9), D4:n(-7), E4:n(-5), F4:n(-4), G4:n(-2), A4:n(0), B4:n(2), C5:n(3) };
  const melody = [
    [NOTES.C4,0.5],[NOTES.C4,0.5],[NOTES.D4,1],[NOTES.C4,1],[NOTES.F4,1],[NOTES.E4,2],
    [NOTES.C4,0.5],[NOTES.C4,0.5],[NOTES.D4,1],[NOTES.C4,1],[NOTES.G4,1],[NOTES.F4,2]
  ];
  function scheduleMelody(startTime){
    if(!melodyToggle.checked) return;
    const secPerBeat = 60/parseInt(bpmEl.value);
    let t = startTime;
    for(const [freq, beats] of melody){
      beep(t, freq, Math.min(0.35, 0.85*beats*secPerBeat));
      t += beats*secPerBeat;
    }
  }
  function startMelodyLoop(){
    stopMelodyLoop();
    const secPerBeat = 60/parseInt(bpmEl.value);
    const loopDur = 16 * 0.25 * secPerBeat; // 16 semicorcheas
    scheduleMelody(ctx.currentTime + 0.1);
    melodyTimer = setInterval(() => scheduleMelody(ctx.currentTime + 0.1), loopDur*1000);
  }
  function stopMelodyLoop(){
    if (melodyTimer) { clearInterval(melodyTimer); melodyTimer = null; }
  }

  /* ----------------------------- UI/GRID ----------------------------- */
  function renderGrid(){
    sequencerEl.innerHTML='';
    ['kick','snare','hat'].forEach(name=>{
      const row=document.createElement('div'); row.className='track';
      const label=document.createElement('div'); label.className='label'; label.textContent=name.toUpperCase();
      row.appendChild(label);
      const steps=document.createElement('div'); steps.className='steps';
      kit[name].forEach((on,i)=>{
        const cell=document.createElement('div'); cell.className='step'+(on?' on':'');
        cell.dataset.row=name; cell.dataset.idx=i;
        cell.setAttribute('tabindex', 0); // accesibilidad: navegable por teclado
        cell.setAttribute('aria-label', `${name} paso ${i+1}`);
        cell.addEventListener('click',()=>{ kit[name][i]=!kit[name][i]; cell.classList.toggle('on'); });
        cell.addEventListener('keydown',e=>{ // permite activar/desactivar con Enter/Espacio
          if(e.key==="Enter"||e.key===" "){
            kit[name][i]=!kit[name][i]; cell.classList.toggle('on'); e.preventDefault();
          }
        });
        steps.appendChild(cell);
      });
      row.appendChild(steps); sequencerEl.appendChild(row);
    });
  }
  function highlight(col){
    document.querySelectorAll('.step').forEach(el=> el.classList.remove('playing'));
    document.querySelectorAll(`.steps .step:nth-child(${(col%16)+1})`).forEach(el=> el.classList.add('playing'));
  }

  /* --------------------------- Scheduler ---------------------------- */
  function nextNote(){
    const spb = 60/parseInt(bpmEl.value);
    nextNoteTime += 0.25 * spb; // semicorchea
    current16th = (current16th + 1) % 16;
  }
  function schedule(){
    while (nextNoteTime < ctx.currentTime + scheduleAhead){
      const step = current16th;
      if (kit.kick[step])  makeKick(nextNoteTime);
      if (kit.snare[step]) makeSnare(nextNoteTime);
      if (kit.hat[step])   makeHat(nextNoteTime);
      const col = step; setTimeout(()=>highlight(col), (nextNoteTime-ctx.currentTime)*1000);
      nextNote();
    }
    timerID = setTimeout(schedule, lookahead);
  }

  /* --------------------------- Controles ---------------------------- */
  document.getElementById('start').addEventListener('click', async ()=>{
    ensureAudio();
    if (playing) return;
    nextNoteTime = ctx.currentTime + 0.06; current16th = 0;
    schedule();
    playing = true;

    if (ttsToggle.checked && 'speechSynthesis' in window){
      const u = new SpeechSynthesisUtterance('¡Feliz cumpleaños!');
      u.lang='es-ES'; u.rate=1.02; u.pitch=1.1; window.speechSynthesis.speak(u);
    }
    startMelodyLoop();
  });

  document.getElementById('stop').addEventListener('click', ()=>{
    playing=false; clearTimeout(timerID); highlight(1000); stopMelodyLoop();
  });

  patternEl.addEventListener('change', e=> loadPattern(e.target.value));

  loadPattern('party');
  renderGrid();
})();