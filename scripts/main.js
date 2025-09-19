/**
 * YouTube Jukebox – main.js v0.2.0
 * - Mini players (MAIN + OVERLAY) 200x200, draggable & persistent
 * - Close (×) button on both mini players (stops and hides)
 * - Stop now hides the corresponding mini player immediately
 * - Removed extra Pause/Play buttons from mini players (use YouTube controls)
 * - Overlay improvements (per-client volume via FAB popover)
 * - Draggable FAB with per-client position (volume popover follows)
 * - Configurable keybinding (default Ctrl/Cmd + K) via Foundry's Keybindings UI
 * - NEW: Search box (filters by title/id)
 * - NEW: Favorites (★) + “Favorites only” filter
 * - NEW: Clear All (per playlist)
 * - NEW: Loop/Repeat: off / track / playlist
 * - NEW: Drag & drop real entre playlists
 * - NEW: Import/Export da biblioteca (JSON)
 * - NEW: Permissão “players podem adicionar URLs”
 * - NEW: Modo privado (playback local sem socket)
 * - NEW: API para macros/scripts (play/pause/next/prev/stop)
 * - NEW: Hotkeys extras (Play/Pause, Next)
 */

const YTJ_ID = "yt-jukebox";
const YTJ_CH = `module.${YTJ_ID}`;

/* ------------------------------- Settings ------------------------------- */
Hooks.once("init", () => {
  game.settings.register(YTJ_ID, "controller", {
    name: "Who can control",
    hint: "Who may send play/pause/next commands to everyone.",
    scope: "world", config: true, type: String,
    choices: { gm: "GM only", all: "Everyone" }, default: "all"
  });

  game.settings.register(YTJ_ID, "apiKey", {
    name: "YouTube API Key (optional)",
    hint: "Used to fetch playlist titles. Without it, titles fallback to noembed.com.",
    scope: "world", config: true, type: String, default: ""
  });

  game.settings.register(YTJ_ID, "library", {
    name: "Library (do not edit manually)",
    scope: "world", config: false, type: Object, default: { groups: [] }
  });

  game.settings.register(YTJ_ID, "clientVol", {
    name: "Client Volume (Main)",
    scope: "client", config: false, type: Number, default: 40
  });

  game.settings.register(YTJ_ID, "clientVolOverlay", {
    name: "Client Volume (Overlay)",
    scope: "client", config: false, type: Number, default: 40
  });

  // Client-persistent FAB position
  game.settings.register(YTJ_ID, "fabPos", {
    name: "FAB Position",
    scope: "client", config: false, type: Object, default: { top: 10, left: 56 }
  });

  // Client-persistent Mini Player positions
  game.settings.register(YTJ_ID, "miniPos", {
    name: "Mini Player Position (Main)",
    scope: "client", config: false, type: Object, default: { top: 120, left: 120 }
  });
  game.settings.register(YTJ_ID, "miniPosOverlay", {
    name: "Mini Player Position (Overlay)",
    scope: "client", config: false, type: Object, default: { top: 120, left: 350 }
  });

  // NEW: players podem adicionar?
  game.settings.register(YTJ_ID, "canPlayersAdd", {
    name: "Players can add URLs",
    scope: "world", config: true, type: Boolean, default: true
  });

  // NEW: modo privado (sem socket, só local)
  game.settings.register(YTJ_ID, "privateMode", {
    name: "Private playback (this client only)",
    hint: "If enabled, play/pause/next will NOT broadcast via socket.",
    scope: "client", config: true, type: Boolean, default: false
  });

  // Keybinding (configurable in Foundry's Keybindings UI)
  game.keybindings.register(YTJ_ID, "toggleUI", {
    name: "Toggle YouTube Jukebox",
    hint: "Open/close the YouTube Jukebox panel.",
    editable: [{ key: "KeyK", modifiers: ["CONTROL"] }],
    onDown: () => { YTJ_App.toggle(); return true; },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });

game.keybindings.register(YTJ_ID, "playPause", {
  name: "Play/Pause",
  hint: "Toggle playback of the selected track in YouTube Jukebox",
  editable: [
    {
      key: "Enter",        // tecla principal
      modifiers: ["Shift"] // modificador
    }
  ],
  onDown: () => {
    if (YTJ_State.paused) {
      YTJ_Control.playSelected();
    } else {
      YTJ_Control.pause();
    }
    return true;
  },
  restricted: false // se true, só GM pode usar
});

  game.keybindings.register(YTJ_ID, "next", {
    name: "Next track",
    editable: [{key:"ArrowRight", modifiers:["SHIFT"]}],
    onDown: ()=>{ YTJ_Control.next(); return true; }
  });
});

Hooks.once("ready", () => {
  YTJ_Library.load();
  game.socket.on(YTJ_CH, YTJ_Socket.onMessage);

  const mod = game.modules.get(YTJ_ID);
  if (mod) mod.api = {
    open: () => YTJ_App.toggle(true),
    close: () => YTJ_App.close(),
    toggle: () => YTJ_App.toggle(),
    play: (queryOrId) => {
      // id direto?
      const posById = YTJ_Library.findVideo(queryOrId);
      if (posById) return YTJ_Control.playAt(posById.g, posById.i);
      // por nome aproximado
      const G=YTJ_Library.data.groups;
      const q=String(queryOrId||"").toLowerCase();
      for (let gi=0; gi<G.length; gi++){
        const ii = G[gi].items.findIndex(x=> (x.title||"").toLowerCase().includes(q));
        if (ii>=0) return YTJ_Control.playAt(gi,ii);
      }
      ui.notifications?.warn("Track not found.");
    },
    pause: () => YTJ_Control.pause(),
    stop: () => YTJ_Control.stop(),
    next: () => YTJ_Control.next(),
    prev: () => YTJ_Control.prev(),
    setVolume: (v) => { YTJ_Player.setVolume(v); },
    setOverlayVolume: (v) => { YTJ_Player.setVolumeBg(v); }
  };

  YTJ_UI.createFabWithVolume();
});

/* ------------------------------- State ------------------------------- */
const YTJ_State = {
  // main
  g: -1, i: -1,
  selG: -1, selI: -1,
  paused: false, pausedTime: 0, stopped: true,
  // overlay
  bgG: -1, bgI: -1,
  bgPaused: false, bgPausedTime: 0, bgActive: false,

  // NEW: UI states
  searchText: "",
  favOnly: false,
  loopMode: "off", // "off" | "one" | "all"

  controller: () => (game.settings.get(YTJ_ID, "controller") !== "gm" || game.user?.isGM),
  canEditLibrary: () => !!game.user?.isGM,
  renamePendingGroupId: null
};

/* ------------------------------- Mini Player (visible 200x200) ------------------------------- */
const YTJ_Mini = {
  panel: null,
  host: null,   // #ytj-player container (main)
  isVisible: false,

  ensure(){
    if (this.panel) return;

    const pos = game.settings.get(YTJ_ID, "miniPos") || { top:120, left:120 };

    // Panel
    const el = document.createElement("div");
    el.id = "ytj-mini";
    Object.assign(el.style, {
      position: "fixed",
      top: (pos.top||120) + "px",
      left: (pos.left||120) + "px",
      width: "220px",
      minWidth: "220px",
      background: "var(--color-bg, #1e1e1e)",
      color: "var(--color-text, #fff)",
      border: "1px solid var(--color-border-light-tertiary, #555)",
      borderRadius: "10px",
      boxShadow: "0 8px 24px rgba(0,0,0,.35)",
      zIndex: "5002",
      display: "none",
      overflow: "hidden"
    });

    // Header (draggable) + Close
    const hdr = document.createElement("div");
    Object.assign(hdr.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      padding: "6px 8px",
      background: "rgba(255,255,255,.06)",
      cursor: "grab",
      userSelect: "none"
    });
    hdr.innerHTML = `
      <div style="font-weight:600">YouTube Player</div>
      <button id="ytj-mini-close" title="Close player" style="min-width:22px;width:22px;height:22px;line-height:1;border-radius:6px;">×</button>`;
    el.appendChild(hdr);

    // Body (200x200)
    const body = document.createElement("div");
    Object.assign(body.style, {
      width: "100%",
      height: "200px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#000"
    });

    // Host for the YT iframe (#ytj-player)
    let host = document.getElementById("ytj-player");
    if (!host){
      host = document.createElement("div");
      host.id = "ytj-player";
    }
    Object.assign(host.style, {
      width: "200px",
      height: "200px",
      border: "0"
    });
    body.appendChild(host);
    el.appendChild(body);

    document.body.appendChild(el);

    // Refs
    this.panel = el;
    this.host  = host;

    // Close button
    el.querySelector("#ytj-mini-close").addEventListener("click", ()=>{
      YTJ_Control.stop(); // also hides panel (see stop)
    });

    // Drag
    this._setupDrag(hdr, el, "miniPos");
  },

  _setupDrag(handle, el, settingKey){
    let dragging=false, pid=null, offX=0, offY=0;
    let tLeft=parseInt(el.style.left,10)||120, tTop=parseInt(el.style.top,10)||120;
    let raf=false;

    const apply=()=>{ raf=false; el.style.left=tLeft+"px"; el.style.top=tTop+"px"; };

    const onMove=(e)=>{
      if(!dragging || e.pointerId!==pid) return;
      const rect=el.getBoundingClientRect();
      const vw=window.innerWidth, vh=window.innerHeight;
      let L=e.clientX-offX, T=e.clientY-offY;
      L=Math.max(4, Math.min(vw-rect.width-4, L));
      T=Math.max(4, Math.min(vh-rect.height-4, T));
      tLeft=L; tTop=T;
      if(!raf){ raf=true; requestAnimationFrame(apply); }
    };
    const onUp=(e)=>{
      if(e.pointerId!==pid) return;
      dragging=false; pid=null; handle.style.cursor="grab";
      const top=tTop, left=tLeft;
      game.settings.set(YTJ_ID, settingKey, {top,left});
      window.removeEventListener("pointermove", onMove);
    };
    handle.addEventListener("pointerdown",(e)=>{
      if(e.button!==0) return;
      e.preventDefault();
      dragging=true; pid=e.pointerId; handle.style.cursor="grabbing";
      const rect=el.getBoundingClientRect();
      offX=e.clientX-rect.left; offY=e.clientY-rect.top;
      window.addEventListener("pointermove", onMove, { passive:true });
      window.addEventListener("pointerup", onUp, { once:true });
    });
  },

  attachHostToPanel(){
    this.ensure();
    const body = this.panel?.children?.[1];
    if (body && this.host && this.host.parentElement !== body){
      try { body.appendChild(this.host); } catch {}
    }
  },

  show(){ this.ensure(); this.attachHostToPanel(); if (!this.isVisible){ this.panel.style.display="block"; this.isVisible=true; } },
  hide(){ if (this.panel){ this.panel.style.display="none"; this.isVisible=false; } }
};

/* ------------------------------- Mini Player (OVERLAY, 200x200) ------------------------------- */
const YTJ_MiniBg = {
  panel: null,
  host: null,   // #ytj-player-ol container (overlay)
  isVisible: false,

  ensure(){
    if (this.panel) return;

    const pos = game.settings.get(YTJ_ID, "miniPosOverlay") || { top:120, left:350 };

    // Panel
    const el = document.createElement("div");
    el.id = "ytj-mini-ol";
    Object.assign(el.style, {
      position: "fixed",
      top: (pos.top||120) + "px",
      left: (pos.left||350) + "px",
      width: "220px",
      minWidth: "220px",
      background: "var(--color-bg, #1e1e1e)",
      color: "var(--color-text, #fff)",
      border: "1px solid var(--color-border-light-tertiary, #555)",
      borderRadius: "10px",
      boxShadow: "0 8px 24px rgba(0,0,0,.35)",
      zIndex: "5002",
      display: "none",
      overflow: "hidden"
    });

    // Header (draggable) + Close
    const hdr = document.createElement("div");
    Object.assign(hdr.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      padding: "6px 8px",
      background: "rgba(255,255,255,.06)",
      cursor: "grab",
      userSelect: "none"
    });
    hdr.innerHTML = `
      <div style="font-weight:600">Overlay Player</div>
      <button id="ytj-mini-ol-close" title="Close overlay player" style="min-width:22px;width:22px;height:22px;line-height:1;border-radius:6px;">×</button>`;
    el.appendChild(hdr);

    // Body (200x200)
    const body = document.createElement("div");
    Object.assign(body.style, {
      width: "100%",
      height: "200px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#000"
    });

    // Host for the YT iframe (#ytj-player-ol)
    let host = document.getElementById("ytj-player-ol");
    if (!host){
      host = document.createElement("div");
      host.id = "ytj-player-ol";
    }
    Object.assign(host.style, {
      width: "200px",
      height: "200px",
      border: "0"
    });
    body.appendChild(host);
    el.appendChild(body);

    document.body.appendChild(el);

    // Refs
    this.panel = el;
    this.host  = host;

    // Close button
    el.querySelector("#ytj-mini-ol-close").addEventListener("click", ()=>{
      YTJ_Control.stopOverlay(); // also hides panel (see stopOverlay)
    });

    // Drag
    this._setupDrag(hdr, el, "miniPosOverlay");
  },

  _setupDrag(handle, el, settingKey){
    let dragging=false, pid=null, offX=0, offY=0;
    let tLeft=parseInt(el.style.left,10)||350, tTop=parseInt(el.style.top,10)||120;
    let raf=false;

    const apply=()=>{ raf=false; el.style.left=tLeft+"px"; el.style.top=tTop+"px"; };

    const onMove=(e)=>{
      if(!dragging || e.pointerId!==pid) return;
      const rect=el.getBoundingClientRect();
      const vw=window.innerWidth, vh=window.innerHeight;
      let L=e.clientX-offX, T=e.clientY-offY;
      L=Math.max(4, Math.min(vw-rect.width-4, L));
      T=Math.max(4, Math.min(vh-rect.height-4, T));
      tLeft=L; tTop=T;
      if(!raf){ raf=true; requestAnimationFrame(apply); }
    };
    const onUp=(e)=>{
      if(e.pointerId!==pid) return;
      dragging=false; pid=null; handle.style.cursor="grab";
      const top=tTop, left=tLeft;
      game.settings.set(YTJ_ID, settingKey, {top,left});
      window.removeEventListener("pointermove", onMove);
    };
    handle.addEventListener("pointerdown",(e)=>{
      if(e.button!==0) return;
      e.preventDefault();
      dragging=true; pid=e.pointerId; handle.style.cursor="grabbing";
      const rect=el.getBoundingClientRect();
      offX=e.clientX-rect.left; offY=e.clientY-rect.top;
      window.addEventListener("pointermove", onMove, { passive:true });
      window.addEventListener("pointerup", onUp, { once:true });
    });
  },

  attachHostToPanel(){
    this.ensure();
    const body = this.panel?.children?.[1];
    if (body && this.host && this.host.parentElement !== body){
      try { body.appendChild(this.host); } catch {}
    }
  },

  show(){ this.ensure(); this.attachHostToPanel(); if (!this.isVisible){ this.panel.style.display="block"; this.isVisible=true; } },
  hide(){ if (this.panel){ this.panel.style.display="none"; this.isVisible=false; } }
};

/* ------------------------------- Socket ------------------------------- */
const YTJ_Socket = {
  emit(p){ game.socket.emit(YTJ_CH, p); },
  onMessage(p){
    if (!p || !p.cmd) return;
    switch (p.cmd) {
      // library sync
      case "lib-set": YTJ_Library.applyRemote(p.lib); break;

      // main player
      case "play": (async()=>{ const {id,g,i,t}=p; await YTJ_Player.play(id,t); YTJ_State.g=g; YTJ_State.i=i; YTJ_State.paused=false; YTJ_State.stopped=false; if(YTJ_State.selG<0){YTJ_State.selG=g;YTJ_State.selI=i;} YTJ_UI.refresh(); })(); break;
      case "pause": (async()=>{ await YTJ_Player.pauseAt(p.t); YTJ_State.paused=true; YTJ_State.pausedTime=p.t ?? YTJ_Player.time; })(); break;
      case "stop": (async()=>{ await YTJ_Player.hardStop(true); YTJ_State.paused=false; YTJ_State.pausedTime=0; YTJ_State.stopped=true; })(); break;
      case "seek": (async()=>{ await YTJ_Player.seek(p.t); })(); break;

      // overlay player
      case "playBg": (async()=>{ const {id,g,i,t}=p; await YTJ_Player.playBg(id,t); YTJ_State.bgG=g; YTJ_State.bgI=i; YTJ_State.bgPaused=false; YTJ_State.bgActive=true; YTJ_UI.refresh(); })(); break;
      case "pauseBg": (async()=>{ await YTJ_Player.pauseBgAt(p.t); YTJ_State.bgPaused=true; YTJ_State.bgPausedTime=p.t ?? YTJ_Player.timeBg; YTJ_UI.refresh(); })(); break;
      case "stopBg": (async()=>{ await YTJ_Player.hardStopBg(true); YTJ_State.bgPaused=false; YTJ_State.bgPausedTime=0; YTJ_State.bgActive=false; YTJ_State.bgG=-1; YTJ_State.bgI=-1; YTJ_UI.refresh(); })(); break;
      case "seekBg": (async()=>{ await YTJ_Player.seekBg(p.t); })(); break;
    }
  }
};

/* ------------------------------- Library ------------------------------- */
const YTJ_Library = {
  data: { groups: [] },

  load(){
    try { this.data = this._ensureDefaults(game.settings.get(YTJ_ID,"library")||{groups:[]}); }
    catch { this.data = this._ensureDefaults({groups:[]}); }
  },

  async save(broadcast=true){
    if (!YTJ_State.canEditLibrary()) return;
    await game.settings.set(YTJ_ID,"library", this.data);
    if (broadcast && !game.settings.get(YTJ_ID,"privateMode")) YTJ_Socket.emit({ cmd:"lib-set", lib:this.data });
  },

  applyRemote(lib){
    if (!lib || !lib.groups) return;
    this.data = this._ensureDefaults(lib);
    const g = this.data.groups[YTJ_State.selG];
    if (!g) { YTJ_State.selG=-1; YTJ_State.selI=-1; }
    else if (YTJ_State.selI >= g.items.length) { YTJ_State.selI = g.items.length-1; if (YTJ_State.selI<0) { YTJ_State.selG=-1; } }
    YTJ_UI.refresh();
  },

  _ensureDefaults(obj){
    const out = { groups: Array.isArray(obj.groups) ? obj.groups.slice() : [] };
    if (!out.groups.length) out.groups.push({ id:"unsorted", name:"Unsorted", collapsed:false, items:[] });
    return out;
  },

  groupIndexById(id){ return this.data.groups.findIndex(g=>g.id===id); },
  createGroup(name, items=[]){ const g={ id:`g_${randomId(8)}`, name:name||"New Playlist", collapsed:false, items:items.slice() }; this.data.groups.push(g); return this.data.groups.length-1; },
  deleteGroup(gi){ const g=this.data.groups[gi]; if (!g) return; this.data.groups.splice(gi,1); },
  renameGroup(gi, name){ const g=this.data.groups[gi]; if(!g) return; g.name = String(name||"").trim() || g.name; },
  toggleCollapsed(gi){ const g=this.data.groups[gi]; if(!g) return; g.collapsed=!g.collapsed; },

  addItemTo(gi, item){ const g=this.data.groups[gi]; if(!g||!item?.id) return; if(!g.items.some(x=>x.id===item.id)) g.items.push({ id:item.id, title:item.title||item.id, fav:false }); },
  deleteItem(gi, ii){ const g=this.data.groups[gi]; if(!g) return; g.items.splice(ii,1); },

  moveItem(fromG, fromI, toG){
    if (fromG===toG) return;
    const gFrom = this.data.groups[fromG], gTo = this.data.groups[toG];
    if (!gFrom || !gTo) return;
    const it = gFrom.items[fromI]; if (!it) return;
    gFrom.items.splice(fromI,1);
    if (!gTo.items.some(x=>x.id===it.id)) gTo.items.push(it);
  },

  nextPos(g,i){
    const G=this.data.groups;
    if (G[g] && i+1 < G[g].items.length) return { g, i:i+1 };
    for (let gi=g+1; gi<G.length; gi++) if (G[gi].items.length) return { g:gi, i:0 };
    return null;
  },
  prevPos(g,i){
    const G=this.data.groups;
    if (i-1 >= 0) return { g, i:i-1 };
    for (let gi=g-1; gi>=0; gi--) { const len=G[gi].items.length; if (len) return { g:gi, i:len-1 }; }
    return null;
  },
  getItem(g,i){ const grp=this.data.groups[g]; return grp? grp.items[i]||null : null; },
  firstPos(){ const G=this.data.groups; for (let gi=0; gi<G.length; gi++) if (G[gi].items.length) return { g:gi, i:0 }; return { g:-1, i:-1 }; },
  findVideo(id){ const G=this.data.groups; for (let gi=0; gi<G.length; gi++){ const ii = G[gi].items.findIndex(x=>x.id===id); if (ii>=0) return { g:gi, i:ii }; } return null; }
};

/* ------------------------------- Player (2 instances) ------------------------------- */
const YTJ_Player = {
  _mounted:false, _player:null, _readyPromise:null, _readyResolve:null,
  _mountedBg:false, _playerBg:null, _readyPromiseBg:null, _readyResolveBg:null,
  // flags to avoid showing mini panel during STOP pause/seek
  _suppressShowOnce:false,
  _suppressShowOnceBg:false,

  /* ---------- main ---------- */
  async mountOnce(){ if(this._mounted) return; this._mounted=true; this._ensureHost(); await this._loadAPI(); this._create(); await this.ready(); },
  _ensureHost(){
    // ensure mini panel and host inside it
    YTJ_Mini.ensure();
    let host=document.getElementById("ytj-player");
    if(!host){
      host=document.createElement("div");
      host.id="ytj-player";
    }
    Object.assign(host.style,{ width:"200px", height:"200px", border:"0", background:"#000", borderRadius:"2px" });
    YTJ_Mini.attachHostToPanel();
  },
  _loadAPI(){ if (window.YT?.Player) return Promise.resolve(); return new Promise(res=>{ const s=document.createElement("script"); s.src="https://www.youtube.com/iframe_api"; window.onYouTubeIframeAPIReady=()=>res(); document.head.appendChild(s); }); },
  _create(){
    const playerVars={ playsinline:1, controls:1, modestbranding:1, rel:0 };
    if (location.protocol==="https:") playerVars.origin = location.origin;
    this._readyPromise = new Promise(r=>this._readyResolve=r);
    this._player = new YT.Player("ytj-player", {
      height:"200", width:"200", playerVars,
      events:{
        onReady:()=>{ try{ this._player.setVolume(clamp0to100(Number(game.settings.get(YTJ_ID,"clientVol"))||40)); }catch{} this._readyResolve?.(true); },
        onError:(e)=>{ const c=Number(e?.data); const msg=(c===2)?"Invalid parameter." : (c===5)?"Playback error in browser." : (c===100)?"Video not found." : (c===101||c===150)?"Embedding disabled by owner." : "YouTube player failure."; ui.notifications?.error(`YouTube: ${msg}`); console.error("[ytj] YT onError", e?.data); },
        onStateChange:(ev)=>{ try{
          if(ev?.data===YT.PlayerState.ENDED){ YTJ_Control._onEnded(); }
          else if(ev?.data===YT.PlayerState.PAUSED){
            if (this._suppressShowOnce){ this._suppressShowOnce=false; return; }
            YTJ_Mini.show();
          }
          else if(ev?.data===YT.PlayerState.PLAYING){ YTJ_Mini.show(); }
        }catch{} }
      }
    });
  },
  async ready(){ if(!this._readyPromise) return true; try{ await this._readyPromise; }catch{} return true; },
  async ensure(){ const host=document.getElementById("ytj-player"); if(!host){ this._mounted=false; this._player=null; this._readyPromise=null; this._readyResolve=null; } await this.mountOnce(); await this.ready(); },

  async play(videoId, startedAt){
    await this.ensure();
    const start = startedAt ? Math.max(0,(Date.now()-startedAt)/1000) : 0;
    try{
      this._player.loadVideoById(videoId, start);
      setTimeout(()=>{ try{ this._player.playVideo(); }catch{} },50);
      // show mini
      YTJ_Mini.show();
      // backfill title later
      setTimeout(()=>{ try{
        const vd=this._player.getVideoData?.()||{};
        if(vd.title){ const pos = YTJ_Library.findVideo(videoId); if(pos){ const item = YTJ_Library.getItem(pos.g,pos.i); if(item && (!item.title || item.title===item.id)){ item.title = vd.title; if(YTJ_State.canEditLibrary()) YTJ_Library.save(true); YTJ_UI.refresh(); } } }
      }catch{} },800);
    }catch(e){ console.error("[ytj] play error", e); ui.notifications?.error("YouTube: failed to start playback (see console)."); }
  },
  async pauseAt(t){ await this.ensure(); try{ this._player.pauseVideo(); if(typeof t==="number") this._player.seekTo(t,true);}catch{} YTJ_Mini.show(); },
  async hardStop(fromSocket=false){
    await this.ensure();
    try{
      this._suppressShowOnce = true; // avoid PAUSED showing mini during stop sequence
      this._player.pauseVideo();
      this._player.seekTo(0,true);
    }catch{}
    // hide immediately on STOP
    YTJ_Mini.hide();
  },
  async seek(t){ await this.ensure(); try{ this._player.seekTo(t,true);}catch{} },
  get time(){ try{ return this._player.getCurrentTime()||0; }catch{ return 0; } },
  setVolume(v){ try{ this._player?.setVolume?.(clamp0to100(Number(v)||0)); }catch{} },

  /* ---------- overlay ---------- */
  async mountOnceBg(){ if(this._mountedBg) return; this._mountedBg=true; this._ensureHostBg(); await this._loadAPI(); this._createBg(); await this.readyBg(); },
  _ensureHostBg(){
    // ensure overlay mini panel and host inside it
    YTJ_MiniBg.ensure();
    let host=document.getElementById("ytj-player-ol");
    if(!host){
      host=document.createElement("div");
      host.id="ytj-player-ol";
    }
    Object.assign(host.style,{ width:"200px", height:"200px", border:"0", background:"#000", borderRadius:"2px" });
    YTJ_MiniBg.attachHostToPanel();
  },
  _createBg(){
    const playerVars={ playsinline:1, controls:1, modestbranding:1, rel:0 };
    if (location.protocol==="https:") playerVars.origin = location.origin;
    this._readyPromiseBg = new Promise(r=>this._readyResolveBg=r);
    this._playerBg = new YT.Player("ytj-player-ol", {
      height:"200", width:"200", playerVars,
      events:{
        onReady:()=>{ try{ this._playerBg.setVolume(clamp0to100(Number(game.settings.get(YTJ_ID,"clientVolOverlay"))||40)); }catch{} this._readyResolveBg?.(true); },
        onError:(e)=>{ const c=Number(e?.data); const msg=(c===2)?"Invalid parameter." : (c===5)?"Playback error in browser." : (c===100)?"Video not found." : (c===101||c===150)?"Embedding disabled by owner." : "YouTube player failure."; ui.notifications?.error(`Overlay: ${msg}`); console.error("[ytj] YT overlay onError", e?.data); },
        onStateChange:(ev)=>{ try{
          if(ev?.data===YT.PlayerState.ENDED){ YTJ_State.bgActive=false; YTJ_MiniBg.hide(); YTJ_UI.refresh(); }
          else if(ev?.data===YT.PlayerState.PAUSED){
            if (this._suppressShowOnceBg){ this._suppressShowOnceBg=false; return; }
            YTJ_MiniBg.show();
          }
          else if(ev?.data===YT.PlayerState.PLAYING){ YTJ_MiniBg.show(); }
        }catch{} }
      }
    });
  },
  async readyBg(){ if(!this._readyPromiseBg) return true; try{ await this._readyPromiseBg; }catch{} return true; },
  async ensureBg(){ const host=document.getElementById("ytj-player-ol"); if(!host){ this._mountedBg=false; this._playerBg=null; this._readyPromiseBg=null; this._readyResolveBg=null; } await this.mountOnceBg(); await this.readyBg(); },

  async playBg(videoId, startedAt){
    await this.ensureBg();
    const start = startedAt ? Math.max(0,(Date.now()-startedAt)/1000) : 0;
    try{
      this._playerBg.loadVideoById(videoId, start);
      setTimeout(()=>{ try{ this._playerBg.playVideo(); }catch{} },50);
      YTJ_MiniBg.show();
      setTimeout(()=>{ try{
        const vd=this._playerBg.getVideoData?.()||{};
        if(vd.title){ const pos = YTJ_Library.findVideo(videoId); if(pos){ const item = YTJ_Library.getItem(pos.g,pos.i); if(item && (!item.title || item.title===item.id)){ item.title = vd.title; if(YTJ_State.canEditLibrary()) YTJ_Library.save(true); YTJ_UI.refresh(); } } }
      }catch{} },800);
    }catch(e){ console.error("[ytj] playBg error", e); ui.notifications?.error("Overlay: failed to start playback (see console)."); }
  },
  async pauseBgAt(t){ await this.ensureBg(); try{ this._playerBg.pauseVideo(); if(typeof t==="number") this._playerBg.seekTo(t,true);}catch{} YTJ_MiniBg.show(); },
  async hardStopBg(fromSocket=false){
    await this.ensureBg();
    try{
      this._suppressShowOnceBg = true; // avoid overlay mini showing during stop sequence
      this._playerBg.pauseVideo();
      this._playerBg.seekTo(0,true);
    }catch{}
    YTJ_MiniBg.hide();
  },
  async seekBg(t){ await this.ensureBg(); try{ this._playerBg.seekTo(t,true);}catch{} },
  get timeBg(){ try{ return this._playerBg.getCurrentTime()||0; }catch{ return 0; } },
  setVolumeBg(v){ try{ this._playerBg?.setVolume?.(clamp0to100(Number(v)||0)); }catch{} }
};

/* ------------------------------- Control ------------------------------- */
const YTJ_Control = {
  _assertCtrl(){ if(!YTJ_State.controller()){ ui.notifications?.warn("You don't have permission to control the jukebox (check module settings)."); return false; } return true; },

  async loadUrl(url){
    if (!YTJ_State.canEditLibrary() && !game.settings.get(YTJ_ID,"canPlayersAdd"))
      return ui.notifications?.warn("You cannot add tracks.");
    const parsed = YTJ_Util.parse(url);
    if(!parsed){ ui.notifications?.error("Invalid YouTube link."); return; }
    if(!YTJ_State.canEditLibrary() && parsed.playlist)
      return ui.notifications?.warn("Only the GM can import playlists.");

    if(parsed.playlist){
      const plName = (await YTJ_Data.fetchPlaylistTitle(parsed.playlist)) || `Playlist ${parsed.playlist.slice(0,6)}`;
      const items = await YTJ_Data.loadPlaylist(parsed.playlist);
      const gi = YTJ_Library.createGroup(plName, items);
      await YTJ_Library.save(true);
      if (items.some(it=>it.title===it.id)) YTJ_Data.fillTitlesNoApi(YTJ_Library.data.groups[gi].items).catch(()=>{});
      ui.notifications?.info(`Playlist loaded: ${items.length} items.`);
      YTJ_UI.refresh(); if (YTJ_State.selG<0){ YTJ_State.selG=gi; YTJ_State.selI=0; }
    } else if(parsed.video){
      const title = await YTJ_Data.fetchTitleForVideo(parsed.video);
      const gi = YTJ_Library.groupIndexById("unsorted")>=0 ? YTJ_Library.groupIndexById("unsorted") : YTJ_Library.createGroup("Unsorted",[]);
      YTJ_Library.addItemTo(gi, { id:parsed.video, title:title||parsed.video });
      await YTJ_Library.save(true);
      YTJ_UI.refresh(); if (YTJ_State.selG<0){ YTJ_State.selG=gi; YTJ_State.selI=0; }
    }
  },

  createGroupPrompt(usePrompt=false){
    if(!YTJ_State.canEditLibrary()) return ui.notifications?.warn("Only GM can create groups.");
    if (usePrompt) {
      const nm = prompt("New group name:", "New Playlist");
      if(nm && nm.trim()){
        const gi = YTJ_Library.createGroup(nm.trim(), []);
        YTJ_Library.save(true).then(()=>{ YTJ_State.renamePendingGroupId = YTJ_Library.data.groups[gi].id; YTJ_UI.refresh(); });
      }
    } else {
      const gi = YTJ_Library.createGroup("New Playlist", []);
      YTJ_Library.save(true).then(()=>{ YTJ_State.renamePendingGroupId = YTJ_Library.data.groups[gi].id; YTJ_UI.refresh(); });
    }
  },

  select(g,i){ YTJ_State.selG=g; YTJ_State.selI=i; YTJ_UI.refresh(); },

  /* ----- MAIN ----- */
  playSelected(){
    if(!this._assertCtrl()) return;
    let { selG:g, selI:i } = YTJ_State; if(g<0||i<0) ({g,i}=YTJ_Library.firstPos()); if(g<0) return;

    if(YTJ_State.paused && g===YTJ_State.g && i===YTJ_State.i){
      const it = YTJ_Library.getItem(g,i); if(!it) return;
      const t0=Math.max(0, YTJ_State.pausedTime||0); const startedAt = Date.now()-Math.floor(t0*1000);
      const payload={cmd:"play", id:it.id, g, i, t:startedAt}; YTJ_State.paused=false; YTJ_State.stopped=false;
      if (!game.settings.get(YTJ_ID,"privateMode")) YTJ_Socket.emit(payload);
      YTJ_Player.play(it.id, startedAt); YTJ_UI.refresh(); return;
    }

    if(YTJ_State.stopped && g===YTJ_State.g && i===YTJ_State.i){
      const it = YTJ_Library.getItem(g,i); if(!it) return;
      const payload={cmd:"play", id:it.id, g, i, t:Date.now()}; YTJ_State.stopped=false; YTJ_State.paused=false; YTJ_State.pausedTime=0;
      if (!game.settings.get(YTJ_ID,"privateMode")) YTJ_Socket.emit(payload);
      YTJ_Player.play(it.id, payload.t); YTJ_UI.refresh(); return;
    }

    this.playAt(g,i);
  },

  playAt(g,i){
    if(!this._assertCtrl()) return;
    const it = YTJ_Library.getItem(g,i); if(!it) return;
    YTJ_State.g=g; YTJ_State.i=i; YTJ_State.selG=g; YTJ_State.selI=i; YTJ_State.paused=false; YTJ_State.pausedTime=0; YTJ_State.stopped=false;
    const payload={cmd:"play", id:it.id, g, i, t:Date.now()};
    if (!game.settings.get(YTJ_ID,"privateMode")) YTJ_Socket.emit(payload);
    YTJ_Player.play(it.id, payload.t); YTJ_UI.refresh();
  },

  pause(){
    if(!this._assertCtrl()) return;
    const t=YTJ_Player.time; YTJ_State.paused=true; YTJ_State.pausedTime=t; YTJ_State.stopped=false;
    if (!game.settings.get(YTJ_ID,"privateMode")) YTJ_Socket.emit({cmd:"pause", t});
    YTJ_Player.pauseAt(t);
  },
  stop(){
    if(!this._assertCtrl()) return;
    YTJ_State.paused=false; YTJ_State.pausedTime=0; YTJ_State.stopped=true;
    if (!game.settings.get(YTJ_ID,"privateMode")) YTJ_Socket.emit({cmd:"stop"});
    YTJ_Player.hardStop(); YTJ_Mini.hide();
  },
  seek(t){ if(!this._assertCtrl()) return; if (!game.settings.get(YTJ_ID,"privateMode")) YTJ_Socket.emit({cmd:"seek", t}); YTJ_Player.seek(t); },
  next(){ if(!this._assertCtrl()) return; const pos=(YTJ_State.g>=0&&YTJ_State.i>=0)?{g:YTJ_State.g,i:YTJ_State.i}:YTJ_Library.firstPos(); if(pos.g<0) return; const n=YTJ_Library.nextPos(pos.g,pos.i); if(n) this.playAt(n.g,n.i); },
  prev(){ if(!this._assertCtrl()) return; const pos=(YTJ_State.g>=0&&YTJ_State.i>=0)?{g:YTJ_State.g,i:YTJ_State.i}:YTJ_Library.firstPos(); if(pos.g<0) return; const p=YTJ_Library.prevPos(pos.g,pos.i); if(p) this.playAt(p.g,p.i); },

  // respeita Loop/Repeat
  _onEnded(){
    const mode = YTJ_State.loopMode;
    if (mode === "one"){
      if (YTJ_State.g>=0 && YTJ_State.i>=0) this.playAt(YTJ_State.g, YTJ_State.i);
      return;
    }
    if (mode === "all"){
      const n = YTJ_Library.nextPos(YTJ_State.g, YTJ_State.i) || YTJ_Library.firstPos();
      if (n) this.playAt(n.g, n.i);
      return;
    }
    const n=YTJ_Library.nextPos(YTJ_State.g,YTJ_State.i);
    if(n) this.playAt(n.g,n.i);
  },

  /* ----- OVERLAY ----- */
  playOverlaySelected(){
    if(!this._assertCtrl()) return;
    let { selG:g, selI:i } = YTJ_State; if(g<0||i<0) ({g,i}=YTJ_Library.firstPos()); if(g<0) return;
    const it = YTJ_Library.getItem(g,i); if(!it) return;
    YTJ_State.bgG = g; YTJ_State.bgI = i; YTJ_State.bgPaused=false; YTJ_State.bgActive=true;
    const payload={cmd:"playBg", id:it.id, g, i, t:Date.now()};
    if (!game.settings.get(YTJ_ID,"privateMode")) YTJ_Socket.emit(payload);
    YTJ_Player.playBg(it.id, payload.t);
    const v = clamp0to100(Number(game.settings.get(YTJ_ID,"clientVolOverlay"))||40);
    YTJ_Player.setVolumeBg(v);
    YTJ_UI.refresh();
  },

  pauseOverlay(){
    if(!this._assertCtrl()) return;
    const t = YTJ_Player.timeBg;
    YTJ_State.bgPaused=true; YTJ_State.bgPausedTime=t;
    if (!game.settings.get(YTJ_ID,"privateMode")) YTJ_Socket.emit({cmd:"pauseBg", t});
    YTJ_Player.pauseBgAt(t); YTJ_UI.refresh();
  },

  stopOverlay(){
    if(!this._assertCtrl()) return;
    YTJ_State.bgPaused=false; YTJ_State.bgPausedTime=0; YTJ_State.bgActive=false;
    if (!game.settings.get(YTJ_ID,"privateMode")) YTJ_Socket.emit({cmd:"stopBg"});
    YTJ_Player.hardStopBg(); YTJ_State.bgG=-1; YTJ_State.bgI=-1; YTJ_MiniBg.hide(); YTJ_UI.refresh();
  },

  moveItem(fromG, fromI, toG){
    if(!YTJ_State.canEditLibrary()) return ui.notifications?.warn("Only GM can modify the library.");
    YTJ_Library.moveItem(fromG, fromI, toG);
    YTJ_Library.save(true).then(()=>YTJ_UI.refresh());
  }
};

/* ------------------------------- Data ------------------------------- */
const YTJ_Data = {
  async loadPlaylist(plId){
    const key=String(game.settings.get(YTJ_ID,"apiKey")||"").trim();
    if(!key){ const ids=await this._idsFromIframe(plId); return ids.map(id=>({id,title:id,fav:false})); }

    const items=[]; let pageToken="";
    while(true){
      const url=new URL("https://www.googleapis.com/youtube/v3/playlistItems");
      url.searchParams.set("part","snippet,contentDetails"); url.searchParams.set("maxResults","50");
      url.searchParams.set("playlistId",plId); url.searchParams.set("key",key);
      if(pageToken) url.searchParams.set("pageToken", pageToken);
      const r=await fetch(url.toString()); if(!r.ok) throw new Error("YouTube API error");
      const j=await r.json();
      for(const it of (j.items||[])){ const id=it.contentDetails?.videoId; const title=it.snippet?.title||id; if(id) items.push({id,title,fav:false}); }
      pageToken=j.nextPageToken||""; if(!pageToken) break;
    }
    return items;
  },

  async fetchPlaylistTitle(plId){
    const key=String(game.settings.get(YTJ_ID,"apiKey")||"").trim(); if(!key) return null;
    const url=new URL("https://www.googleapis.com/youtube/v3/playlists"); url.searchParams.set("part","snippet"); url.searchParams.set("id",plId); url.searchParams.set("key",key);
    const r=await fetch(url.toString()); if(!r.ok) return null; const j=await r.json(); const it=(j.items||[])[0]; return it?.snippet?.title || null;
  },

  async fillTitlesNoApi(list){
    const missing=list.filter(x=>x&&(x.title===x.id||!x.title)); const limit=5; let i=0;
    async function worker(){ while(i<missing.length){ const item=missing[i++]; if(!item) continue; try{ const title=await YTJ_Data.fetchTitleForVideo(item.id); if(title){ item.title=title; if(YTJ_State.canEditLibrary()) await YTJ_Library.save(true); YTJ_UI.refresh(); } }catch{} } }
    await Promise.all(Array.from({length:Math.min(limit,missing.length)}, worker));
  },

  async fetchTitleForVideo(videoId){
    try{ const u=`https://noembed.com/embed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`; const r=await fetch(u,{mode:"cors"}); if(!r.ok) return null; const j=await r.json(); return j?.title||null; }
    catch{ return null; }
  },

  _idsFromIframe(plId){
    return new Promise((resolve)=>{
      const div=document.createElement("div"); div.id="ytj-temp-pl"; div.style.position="fixed"; div.style.left="-9999px"; div.style.top="-9999px"; document.body.appendChild(div);
      const finish=(ids)=>{ try{div.remove();}catch{} resolve(ids||[]); };
      const create=()=>{ const p=new YT.Player("ytj-temp-pl",{ playerVars:{listType:"playlist", list:plId}, events:{ onReady:()=>{ setTimeout(()=>{ try{ const ids=p.getPlaylist?.()||[]; finish(ids); setTimeout(()=>{ try{p.destroy?.();}catch{} },0); }catch(e){ console.warn(e); finish([]);} },120); } } }); };
      if(window.YT?.Player) create(); else { const s=document.createElement("script"); s.src="https://www.youtube.com/iframe_api"; window.onYouTubeIframeAPIReady=()=>create(); document.head.appendChild(s); }
    });
  }
};

/* ------------------------------- UI (main window) ------------------------------- */
const YTJ_UI = {
  app:null,
  ensureApp(){ if(!this.app) this.app=new YTJ_AppClass(); return this.app; },
  open(){ this.ensureApp().render(true); },
  toggle(){ const a=this.ensureApp(); a.rendered? a.close(): a.render(true); },
  refresh(){ try{ this.app?.render(false); }catch{} },

  createFabWithVolume(){
    const pos = game.settings.get(YTJ_ID, "fabPos") || { top:10, left:56 };

    // FAB
    const fab = document.createElement("button");
    fab.className = "ytj-fab";
    fab.title = "YouTube Jukebox";
    fab.innerHTML = '<i class="fas fa-music"></i>';
    Object.assign(fab.style, {
      position: "fixed",
      top: (pos.top||10) + "px",
      left: (pos.left||56) + "px",
      zIndex: "5000",
      cursor: "grab",
      willChange: "left, top",
      transform: "translateZ(0)"
    });
    fab.addEventListener("click",(e)=>{ e.preventDefault(); e.stopPropagation(); YTJ_App.toggle(); });
    document.body.appendChild(fab);

    // Popover de volume (Main + Overlay)
    const pop = document.createElement("div");
    pop.id = "ytj-vol-pop";
    Object.assign(pop.style, {
      position:"fixed",
      top: ((pos.top||10) + 38) + "px",
      left: (pos.left||56) + "px",
      padding:"8px 10px",
      background:"var(--color-bg,#1e1e1e)",
      border:"1px solid var(--color-border-light-tertiary,#555)",
      borderRadius:"8px",
      boxShadow:"0 6px 18px rgba(0,0,0,.35)",
      zIndex:"5001",
      display:"none",
      color:"var(--color-text,#fff)",
      willChange: "left, top",
      transform: "translateZ(0)"
    });

    const vMain = clamp0to100(Number(game.settings.get(YTJ_ID,"clientVol"))||40);
    const vOL   = clamp0to100(Number(game.settings.get(YTJ_ID,"clientVolOverlay"))||40);

    pop.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px;min-width:240px">
        <div style="display:flex;align-items:center;gap:8px">
          <i class="fas fa-volume-off" style="opacity:.8"></i>
          <input id="ytj-vol-range" type="range" min="0" max="100" value="${vMain}" style="flex:1"/>
          <span id="ytj-vol-val" style="width:2.6em;text-align:right;opacity:.8">${vMain}</span>
          <span style="opacity:.8">Main</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <i class="fas fa-volume-off" style="opacity:.8"></i>
          <input id="ytj-vol-range-ol" type="range" min="0" max="100" value="${vOL}" style="flex:1"/>
          <span id="ytj-vol-val-ol" style="width:2.6em;text-align:right;opacity:.8">${vOL}</span>
          <span style="opacity:.8">OL</span>
        </div>
        <div style="font-size:11px;opacity:.7">Tip: Right-click the music icon to toggle this panel.</div>
      </div>`;
    document.body.appendChild(pop);

    // Mostrar/ocultar popover
    let hideT=null;
    const show=()=>{ clearTimeout(hideT); pop.style.display="block"; };
    const hide=()=>{ hideT=setTimeout(()=>pop.style.display="none", 220); };
    fab.addEventListener("mouseenter", show);
    fab.addEventListener("mouseleave", hide);
    pop.addEventListener("mouseenter", show);
    pop.addEventListener("mouseleave", hide);
    fab.addEventListener("contextmenu",(e)=>{ e.preventDefault(); e.stopPropagation(); pop.style.display=(pop.style.display==="none")?"block":"none"; });

    // Sliders
    const range   = pop.querySelector("#ytj-vol-range");
    const val     = pop.querySelector("#ytj-vol-val");
    const rangeOL = pop.querySelector("#ytj-vol-range-ol");
    const valOL   = pop.querySelector("#ytj-vol-val-ol");

    range.addEventListener("input",(ev)=>{ const v=clamp0to100(Number(ev.currentTarget.value||0)); val.textContent=String(v); game.settings.set(YTJ_ID,"clientVol",v); YTJ_Player.setVolume(v); });
    rangeOL.addEventListener("input",(ev)=>{ const v=clamp0to100(Number(ev.currentTarget.value||0)); valOL.textContent=String(v); game.settings.set(YTJ_ID,"clientVolOverlay",v); YTJ_Player.setVolumeBg(v); });

    /* ------------------------ Drag (rAF + pointer capture) ------------------------ */
    let dragging = false, pointerId = null, offX = 0, offY = 0;
    let targetLeft = parseInt(fab.style.left,10) || (pos.left||56);
    let targetTop  = parseInt(fab.style.top,10)  || (pos.top||10);
    let rafPending = false;

    const applyFrame = ()=>{
      rafPending = false;
      fab.style.left = targetLeft + "px";
      fab.style.top  = targetTop  + "px";
      pop.style.left = targetLeft + "px";
      pop.style.top  = (targetTop + 38) + "px";
    };

    const onMove = (e)=>{
      if (!dragging || e.pointerId !== pointerId) return;
      const bw = fab.offsetWidth || 36, bh = fab.offsetHeight || 36;
      const vw = window.innerWidth, vh = window.innerHeight;

      let L = e.clientX - offX;
      let T = e.clientY - offY;

      L = Math.max(4, Math.min(vw - bw - 4, L));
      T = Math.max(4, Math.min(vh - bh - 4, T));

      targetLeft = L;
      targetTop  = T;

      if (!rafPending){
        rafPending = true;
        requestAnimationFrame(applyFrame);
      }
    };

    const onUp = (e)=>{
      if (e.pointerId !== pointerId) return;
      dragging = false;
      try { fab.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
      fab.style.cursor = "grab";

      const top  = targetTop;
      const left = targetLeft;
      game.settings.set(YTJ_ID, "fabPos", { top, left });
    };

    const onDown = (e)=>{
      if (e.button !== 0) return;
      e.preventDefault();

      dragging = true;
      pointerId = e.pointerId;

      const rect = fab.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;

      fab.style.cursor = "grabbing";
      try { fab.setPointerCapture(pointerId); } catch {}

      clearTimeout(hideT);
      pop.style.display = pop.style.display || "block";

      window.addEventListener("pointermove", onMove, { passive:true });
      window.addEventListener("pointerup", onUp, { once:true });
    };

    fab.addEventListener("pointerdown", onDown);

    window.addEventListener("resize", ()=>{
      if (!rafPending){
        rafPending = true;
        requestAnimationFrame(applyFrame);
      }
    });
  }
};

class YTJ_AppClass extends Application {
  static get defaultOptions(){
    return foundry.utils.mergeObject(super.defaultOptions,{
      id:"ytj-app", title:"YouTube Jukebox", popOut:true, width:820, height:600, resizable:true, classes:["ytj-app"], template:""
    });
  }

  async _renderInner(){
    const root=document.createElement("div");
    const style = `
      <style>
        #ytj-app .window-content{ padding:0 !important; }
        .ytj-root{ min-height:100%; display:flex; flex-direction:column; }
        .ytj-top{
          position:sticky; top:0; z-index:3;
          background:var(--color-bg,#f0f0f0);
          border-bottom:1px solid var(--color-border-light-tertiary);
          box-shadow:0 2px 6px rgba(0,0,0,.12);
          overflow:visible;
        }

        /* linha 1: url + busca + favoritos */
        .ytj-header-row1{
          display:flex; align-items:center; gap:8px;
          padding:10px 10px 6px;
          flex-wrap:wrap;
        }
        .ytj-input{ flex:1 1 280px; height:34px; padding:0 10px; font-size:13px; }
        .ytj-search{ flex:1 1 280px; height:34px; padding:0 10px; font-size:13px; }
        .ytj-fav{ display:flex; align-items:center; gap:6px; white-space:nowrap; }

        /* linha 2: toolbar – tudo lado a lado */
        .ytj-toolbar{
          display:flex; align-items:center; gap:8px;
          padding:6px 10px 10px;
          flex-wrap:wrap;
        }

        /* override do Foundry que alarga botões/inputs */
        .ytj-toolbar button,
        .ytj-toolbar .btn,
        .ytj-toolbar label,
        .ytj-toolbar select,
        .ytj-toolbar input[type="checkbox"],
        .ytj-header-row1 button {
          width:auto !important;
          min-width:unset !important;
          display:inline-flex !important;
          flex:0 0 auto !important;
        }
        .ytj-toolbar select{ height:32px; }

        .ytj-spacer{ flex:1 1 auto; }

        /* conteúdo/listas (inalterado) */
        .ytj-content{ padding:10px; display:flex; flex-direction:column; gap:10px; }
        .ytj-group{ border:1px solid var(--color-border-light-tertiary); border-radius:10px; overflow:hidden; background:rgba(0,0,0,0.03); }
        .ytj-group-header{ display:flex; align-items:center; gap:6px; padding:6px 8px; background:rgba(0,0,0,0.04); }
        .ytj-group-header .icon{ width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center;
                                  border:1px solid var(--color-border-light-tertiary); border-radius:6px; background:var(--color-bg,#f0f0f0);
                                  cursor:pointer; padding:0; }
        .ytj-group-header .icon i{ font-size:11px; line-height:1; }
        .ytj-group-header .name{ font-weight:600; flex:1; cursor:text; padding:2px 6px; }
        .ytj-group-header .name[contenteditable="true"]{ outline:2px solid rgba(100,180,255,.65); border-radius:6px; background:var(--color-bg,#fff); }
        .ytj-group-header .count{ opacity:.7; font-size:12px; width:2.5em; text-align:right; }
        .ytj-group-items{ padding:8px; display:grid; gap:6px; grid-auto-rows:min-content; }

        .ytj-item{ min-height:28px; display:flex; gap:8px; align-items:center; padding:6px 8px;
                   border:1px solid var(--color-border-light-tertiary); border-radius:8px; cursor:pointer; background:var(--ytj-bg,transparent); }
        .ytj-item .idx{ width:2.2em; text-align:right; opacity:.7; }
        .ytj-item .t{ flex:1; }
        .ytj-item .m{ opacity:.55; font-size:11px; }
        .ytj-item .mini{ width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center;
                         border:1px solid var(--color-border-light-tertiary); border-radius:6px; background:var(--color-bg,#f0f0f0);
                         cursor:pointer; padding:0; }
        .ytj-item .mini i{ font-size:11px; line-height:1; }
        .ytj-item.selected{ --ytj-bg:rgba(100,180,255,.12); outline:2px solid rgba(100,180,255,.65); }
        .ytj-item.playing{ background:var(--color-bg-option); }
        .ytj-item.overlaying{ outline:2px solid rgba(255,210,50,.85); box-shadow:0 0 0 3px rgba(255,210,50,.25) inset; }

        .ytj-modal-back{ position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:9998; }
        .ytj-modal{ position:fixed; inset:0; display:flex; align-items:center; justify-content:center; z-index:9999; }
        .ytj-modal .card{ background:var(--color-bg,#1e1e1e); border:1px solid var(--color-border-light-tertiary);
                           border-radius:10px; padding:12px; min-width:300px; box-shadow:0 10px 28px rgba(0,0,0,.45);
                           color:var(--color-text,#fff); }
        .ytj-modal .row{ display:flex; gap:8px; align-items:center; margin-top:10px; justify-content:flex-end; }
        .ytj-modal select{ width:100%; }
      </style>
    `;
    root.innerHTML = `
      ${style}
      <div class="ytj-root">
        <div class="ytj-top">
          <!-- Row 1 -->
          <div class="ytj-header-row1">
            <input id="ytj-url" class="ytj-input" placeholder="Paste a YouTube video or playlist URL…" />
            <input id="ytj-search" class="ytj-search" placeholder="Search in library… (title/id)" value="${escapeHTML(YTJ_State.searchText)}" />
            <label class="ytj-fav">
              <input id="ytj-favOnly" type="checkbox" ${YTJ_State.favOnly ? "checked" : ""}/>
              <span>Favorites only</span>
            </label>
          </div>

          <!-- Row 2: toolbar única -->
          <div class="ytj-toolbar">
            <button id="ytj-join">Enable Audio</button>
            <button id="ytj-load">Add</button>
            <button id="ytj-newgrp" title="Create empty group">New Group</button>
            <button id="ytj-export" title="Export library to JSON">Export</button>
            <button id="ytj-import" title="Import library from JSON">Import</button>
            <input type="file" id="ytj-import-file" accept="application/json" style="display:none" />

            <div class="ytj-spacer"></div>

            <button id="ytj-prev">Previous</button>
            <button id="ytj-play">Play</button>
            <button id="ytj-pause">Pause</button>
            <button id="ytj-stop">Stop</button>
            <button id="ytj-next">Next</button>
            <button id="ytj-sync">Sync</button>

            <label style="display:flex;align-items:center;gap:6px;">
              <span>Loop:</span>
              <select id="ytj-loopSel">
                <option value="off" ${YTJ_State.loopMode==="off"?"selected":""}>Off</option>
                <option value="one" ${YTJ_State.loopMode==="one"?"selected":""}>Track</option>
                <option value="all" ${YTJ_State.loopMode==="all"?"selected":""}>Playlist</option>
              </select>
            </label>

            <button id="ytj-play-ol" title="Play selected as overlay (simultaneous)">Overlay</button>
            <button id="ytj-pause-ol" title="Pause overlay only">Pause OL</button>
            <button id="ytj-stop-ol" title="Stop overlay only">Stop OL</button>
          </div>
        </div>

        <div id="ytj-content" class="ytj-content"></div>
        <div style="padding:8px 10px;font-size:11px;opacity:.75">
          Tip: select a track and use <b>Overlay</b> to play it simultaneously with the main track. Overlay won't auto-advance.
        </div>
      </div>
    `;
    return $(root);
  }

  // Filtro “ao vivo” (sem re-render, mantém foco)
  filterLibrary(query, favOnly = YTJ_State.favOnly) {
    const q = String(query || "").toLowerCase().trim();
    const $root = this.element;

    // filtra itens
    $root.find(".ytj-item").each((_, el) => {
      const title = (el.querySelector(".t")?.textContent || "").toLowerCase();
      const id    = (el.querySelector(".m")?.textContent || "").toLowerCase();
      const isFav = el.querySelector(".mini.fav")?.classList.contains("active");
      const byText = !q || title.includes(q) || id.includes(q);
      const byFav  = !favOnly || !!isFav;
      el.style.display = (byText && byFav) ? "" : "none";
    });

    // esconde/mostra grupos vazios pós-filtro
    $root.find(".ytj-group").each((_, g) => {
      const body = g.querySelector(".ytj-group-items");
      const anyVisible = !!body?.querySelector(".ytj-item:not([style*='display: none'])");
      g.style.display = anyVisible || !q ? "" : "none";
      // contador dinâmico quando filtrando
      const cnt = g.querySelector(".ytj-group-header .count");
      if (cnt) {
        if (q || favOnly) {
          const vis = body?.querySelectorAll(".ytj-item:not([style*='display: none'])").length ?? 0;
          cnt.textContent = String(vis);
        } else {
          // volta ao total real do grupo (re-render repõe corretamente)
          // aqui não alteramos o valor original
        }
      }
    });
  }

  activateListeners(html){
    super.activateListeners(html);

    // SEARCH: sem re-render (mantém foco)
    const $search = html.find("#ytj-search");
    $search.on("input", (ev)=>{
      YTJ_State.searchText = String(ev.currentTarget.value || "");
      this.filterLibrary(YTJ_State.searchText);   // aplica em tempo real
    });

    // FAVORITES ONLY: sem re-render
    const $favOnly = html.find("#ytj-favOnly");
    $favOnly.on("change", (ev)=>{
      YTJ_State.favOnly = !!ev.currentTarget.checked;
      this.filterLibrary(YTJ_State.searchText, YTJ_State.favOnly);
    });

    // LOOP
    html.find("#ytj-loopSel").on("change",(ev)=>{ YTJ_State.loopMode = ev.currentTarget.value; });

    html.find("#ytj-load").on("click", async ()=>{
      const v = String(html.find("#ytj-url").val()||"").trim(); if(!v) return;
      await YTJ_Control.loadUrl(v);
      html.find("#ytj-url").val("");
    });

    // import/export
    html.find("#ytj-export").on("click", ()=>{
      const blob = new Blob([JSON.stringify(YTJ_Library.data, null, 2)], {type:"application/json"});
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ytj-library-${Date.now()}.json`;
      a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
    });
    html.find("#ytj-import").on("click", ()=> html.find("#ytj-import-file")[0].click());
    html.find("#ytj-import-file").on("change", async (ev)=>{
      const f = ev.currentTarget.files?.[0]; if(!f) return;
      const txt = await f.text();
      try{
        const data = JSON.parse(txt);
        if (!YTJ_State.canEditLibrary()) return ui.notifications?.warn("Only GM can import.");
        if (Array.isArray(data?.groups)){
          YTJ_Library.data.groups.push(...data.groups);
          await YTJ_Library.save(true);
          YTJ_UI.refresh();
          ui.notifications?.info("Library imported.");
        } else {
          ui.notifications?.error("Invalid file.");
        }
      }catch{ ui.notifications?.error("Invalid JSON file."); }
      ev.currentTarget.value = "";
    });

    html.find("#ytj-join").on("click", ()=>Promise.all([YTJ_Player.ensure(), YTJ_Player.ensureBg()]).then(()=>ui.notifications?.info("Audio enabled on this client.")));
    html.find("#ytj-play").on("click", ()=>YTJ_Control.playSelected());
    html.find("#ytj-pause").on("click", ()=>YTJ_Control.pause());
    html.find("#ytj-stop").on("click", ()=>YTJ_Control.stop());
    html.find("#ytj-next").on("click", ()=>YTJ_Control.next());
    html.find("#ytj-prev").on("click", ()=>YTJ_Control.prev());
    html.find("#ytj-sync").on("click", ()=>YTJ_Control.seek(YTJ_Player.time));
    html.find("#ytj-newgrp").on("click", ()=> YTJ_Control.createGroupPrompt(false));

    // Overlay
    html.find("#ytj-play-ol").on("click", ()=>YTJ_Control.playOverlaySelected());
    html.find("#ytj-pause-ol").on("click", ()=>YTJ_Control.pauseOverlay());
    html.find("#ytj-stop-ol").on("click", ()=>YTJ_Control.stopOverlay());

    // render library/groups/items
    const host=this.element.find("#ytj-content")[0];
    host.innerHTML="";

    const G = YTJ_Library.data.groups;
    for (let gi=0; gi<G.length; gi++){
      const grp=G[gi];
      const wrapG=document.createElement("div"); wrapG.className="ytj-group";

      const hdr=document.createElement("div"); hdr.className="ytj-group-header";
      hdr.innerHTML = `
        <button class="icon toggle" title="${grp.collapsed?"Expand":"Collapse"}"><i class="fas ${grp.collapsed?"fa-chevron-right":"fa-chevron-down"}"></i></button>
        <div class="name" title="Double-click to rename" contenteditable="false">${escapeHTML(grp.name)}</div>
        <div class="count" title="Items in group">${grp.items.length}</div>
        <button class="icon cleargrp" title="Clear all items"><i class="fas fa-broom"></i></button>
        <button class="icon delgrp" title="Delete group"><i class="fas fa-trash"></i></button>
      `;
      wrapG.appendChild(hdr);

      const body=document.createElement("div"); body.className="ytj-group-items"; body.style.display=grp.collapsed?"none":"grid";

      // drag target (destino)
      body.addEventListener("dragover", (e)=>{ e.preventDefault(); body.classList.add("drop-target"); });
      body.addEventListener("dragleave", ()=> body.classList.remove("drop-target"));
      body.addEventListener("drop", (e)=>{
        e.preventDefault(); body.classList.remove("drop-target");
        const data = e.dataTransfer.getData("text/plain");
        if (!data) return;
        try {
          const { fromG, fromI } = JSON.parse(data);
          if (typeof fromG!=="number" || typeof fromI!=="number") return;
          if(!YTJ_State.canEditLibrary()) return ui.notifications?.warn("Only GM can move tracks.");
          if (fromG===gi) return; // não reordena no mesmo grupo (por enquanto)
          YTJ_Control.moveItem(fromG, fromI, gi);
        } catch {}
      });

      grp.items.forEach((it, ii)=>{
        // (render normal; o filtro é aplicado depois via filterLibrary)
        const el=document.createElement("div"); el.className="ytj-item";
        el.draggable = true; // drag source

        if(gi===YTJ_State.selG && ii===YTJ_State.selI) el.classList.add("selected");
        if(gi===YTJ_State.g && ii===YTJ_State.i) el.classList.add("playing");
        if(gi===YTJ_State.bgG && ii===YTJ_State.bgI && YTJ_State.bgActive) el.classList.add("overlaying");
        const t = it.title || it.id;
        el.innerHTML = `
          <span class="idx">${ii+1}.</span>
          <span class="t">${escapeHTML(t)}</span>
          <span class="m">${escapeHTML(it.id)}</span>
          <button class="mini fav ${it.fav?'active':''}" title="Favorite"><i class="fas fa-star"></i></button>
          <button class="mini move" title="Move to..."><i class="fas fa-arrow-right"></i></button>
          <button class="mini trash" title="Remove"><i class="fas fa-times"></i></button>
        `;
        el.addEventListener("click",(ev)=>{ if (ev.target.closest(".mini")) return; YTJ_Control.select(gi,ii); });

        // drag source events
        el.addEventListener("dragstart", (e)=>{
          el.classList.add("dragging");
          e.dataTransfer.setData("text/plain", JSON.stringify({ fromG: gi, fromI: ii }));
        });
        el.addEventListener("dragend", ()=> el.classList.remove("dragging"));

        // favoritos
        el.querySelector(".fav").addEventListener("click", async (ev)=>{
          ev.stopPropagation();
          it.fav = !it.fav;
          await YTJ_Library.save(true);
          // atualiza estilo local sem re-render
          ev.currentTarget.classList.toggle("active", it.fav);
          // re-aplica filtro atual (caso esteja “Favorites only” ligado)
          this.filterLibrary(YTJ_State.searchText, YTJ_State.favOnly);
        });

        // remover
        el.querySelector(".trash").addEventListener("click", async (ev)=>{
          ev.stopPropagation();
          if(!YTJ_State.canEditLibrary()) return ui.notifications?.warn("Only GM can edit the library.");
          if (confirm("Remove this track from the group?")){
            YTJ_Library.deleteItem(gi,ii);
            await YTJ_Library.save(true);
            if (gi===YTJ_State.g && ii===YTJ_State.i){ YTJ_Control.stop(); YTJ_State.g=-1; YTJ_State.i=-1; }
            if (gi===YTJ_State.bgG && ii===YTJ_State.bgI){ YTJ_Control.stopOverlay(); }
            YTJ_UI.refresh();
          }
        });

        // mover (modal)
        el.querySelector(".move").addEventListener("click",(ev)=>{
          ev.stopPropagation();
          if(!YTJ_State.canEditLibrary()) return ui.notifications?.warn("Only GM can edit the library.");

          const back = document.createElement("div"); back.className="ytj-modal-back";
          const modal = document.createElement("div"); modal.className="ytj-modal";
          const card = document.createElement("div"); card.className="card";
          card.innerHTML = `
            <div><b>Move track</b></div>
            <div style="margin-top:8px">Destination group:</div>
            <select id="ytj-move-sel" style="margin-top:4px"></select>
            <div class="row">
              <button id="ytj-move-cancel">Cancel</button>
              <button id="ytj-move-ok">Move</button>
            </div>`;
          modal.appendChild(card);
          document.body.appendChild(back);
          document.body.appendChild(modal);

          const sel = card.querySelector("#ytj-move-sel");
          YTJ_Library.data.groups.forEach((g, idx)=>{ const o=document.createElement("option"); o.value=String(idx); o.textContent=g.name; if(idx===gi) o.selected=true; sel.appendChild(o); });

          const cleanup = ()=>{ try{ modal.remove(); }catch{} try{ back.remove(); }catch{} };
          card.querySelector("#ytj-move-cancel").addEventListener("click",(e)=>{ e.stopPropagation(); cleanup(); });
          card.querySelector("#ytj-move-ok").addEventListener("click",(e)=>{ e.stopPropagation(); const toG = Number(sel.value); cleanup(); if(toG===gi) return; YTJ_Control.moveItem(gi,ii,toG); });
        });

        body.appendChild(el);
      });

      wrapG.appendChild(body);
      host.appendChild(wrapG);

      // toggle collapse
      hdr.querySelector(".toggle").addEventListener("click", async ()=>{
        YTJ_Library.toggleCollapsed(gi); await YTJ_Library.save(true); YTJ_UI.refresh();
      });

      // clear all
      hdr.querySelector(".cleargrp").addEventListener("click", async ()=>{
        if(!YTJ_State.canEditLibrary()) return ui.notifications?.warn("Only GM can clear groups.");
        if(!confirm(`Remove ALL tracks from "${grp.name}"?`)) return;
        grp.items.length = 0;
        await YTJ_Library.save(true);
        if (gi===YTJ_State.g){ YTJ_Control.stop(); YTJ_State.g=-1; YTJ_State.i=-1; }
        if (gi===YTJ_State.bgG){ YTJ_Control.stopOverlay(); }
        YTJ_UI.refresh();
      });

      // delete group
      hdr.querySelector(".delgrp").addEventListener("click", async ()=>{
        if(!YTJ_State.canEditLibrary()) return ui.notifications?.warn("Only GM can delete groups.");
        if(!confirm(`Delete group "${grp.name}" and all its items?`)) return;
        if (gi===YTJ_State.g){ YTJ_Control.stop(); YTJ_State.g=-1; YTJ_State.i=-1; }
        if (gi===YTJ_State.bgG){ YTJ_Control.stopOverlay(); }
        YTJ_Library.deleteGroup(gi); await YTJ_Library.save(true);
        YTJ_UI.refresh();
      });

      // INLINE RENAME
      const nameEl = hdr.querySelector(".name");
      nameEl.addEventListener("dblclick", () => {
        if(!YTJ_State.canEditLibrary()) return ui.notifications?.warn("Only GM can rename groups.");
        nameEl.setAttribute("contenteditable","true");
        nameEl.focus();
        document.execCommand("selectAll", false, null);
      });
      const finishRename = async () => {
        const newName = nameEl.textContent.trim();
        nameEl.setAttribute("contenteditable","false");
        if (newName && newName !== grp.name){
          YTJ_Library.renameGroup(gi, newName);
          await YTJ_Library.save(true);
          YTJ_UI.refresh();
        } else {
          nameEl.textContent = grp.name;
        }
      };
      nameEl.addEventListener("blur", finishRename);
      nameEl.addEventListener("keydown", (ev)=>{
        if (ev.key === "Enter"){ ev.preventDefault(); nameEl.blur(); }
        if (ev.key === "Escape"){ ev.preventDefault(); nameEl.textContent = grp.name; nameEl.blur(); }
      });

      // focus rename if newly created
      if (YTJ_State.renamePendingGroupId && grp.id === YTJ_State.renamePendingGroupId) {
        YTJ_State.renamePendingGroupId = null;
        setTimeout(()=>{
          nameEl.setAttribute("contenteditable","true");
          nameEl.focus();
          document.execCommand("selectAll", false, null);
        }, 0);
      }
    }

    // aplica filtro atual (se havia texto/flag salvos) — sem perder foco
    this.filterLibrary(YTJ_State.searchText, YTJ_State.favOnly);
  }
}

/* ------------------------------- Utils ------------------------------- */
const YTJ_Util = {
  parse(u){ try{
    const url=new URL(u);
    if(!/youtube\.com|youtu\.be/.test(url.hostname)) return null;
    const v=(url.searchParams.get("v")||"").trim();
    const list=(url.searchParams.get("list")||"").trim();
    if(url.hostname==="youtu.be"){ const seg=url.pathname.split("/").filter(Boolean); if(seg[0]) return {video:seg[0], playlist:list||null}; }
    if(v||list) return { video:v||null, playlist:list||null };
    if(url.pathname.includes("/playlist") && list) return { video:null, playlist:list };
    return null;
  }catch{ return null; } }
};

const YTJ_App = {
  toggle(force){ const a=YTJ_UI.ensureApp(); const open = force ?? !a.rendered; if(open) a.render(true); else a.close(); },
  close(){ YTJ_UI.app?.close(); }
};

/* ------------------------------- Helpers ------------------------------- */
function clamp0to100(n){ n=Number(n)||0; if(n<0)return 0; if(n>100)return 100; return Math.round(n); }
function randomId(len=8){ const c="abcdefghijklmnopqrstuvwxyz0123456789"; let s=""; for(let i=0;i<len;i++) s+=c[(Math.random()*c.length)|0]; return s; }
function escapeHTML(s){ return String(s).replace(/[&<>"']/g,m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
