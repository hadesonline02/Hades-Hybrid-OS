(()=>{
const DG='wss://api.deepgram.com/v1/listen';
const BACKENDS=['http://127.0.0.1:3001','http://localhost:3001'];
const REPLY_TIMEOUT=120000,COMMAND_TIMEOUT=9000,FOLLOWUP_TIMEOUT=2200,WAKE_RESTART=1200,VOICE_OWNER_HEARTBEAT=1200,VOICE_OWNER_RETRY=1800,WAKE_READY_TIMEOUT=3000,WAKE_START_ACK_TIMEOUT=2500,FAST_WAKE_START_ACK_TIMEOUT=1800,BOOTSTRAP_WAKE_START_ACK_TIMEOUT=4200,FAST_WAKE_HANDOFF_MS=1600,FOLLOWUP_WAKE_HANDOFF_MS=900,DG_WAKE_CONNECT_TIMEOUT=2600,FOLLOWUP_DG_WAKE_CONNECT_TIMEOUT=1400,VOICE_CONTEXT_STARTUP_GRACE_MS=4500,DESKTOP_SHELL_WAIT_TIMEOUT_MS=2400,WAKE_ACK_GUARD_MS=1700,ALERT_SYNC_INTERVAL=2000,ALERT_REPEAT_DELAY=2400,STREAM_CHUNK_WAIT_MS=650,STREAM_CHUNK_MIN_CHARS=36,STREAM_CHUNK_SOFT_CHARS=56,STREAM_CHUNK_MAX_CHARS=96,REPLY_FINAL_STABLE_MS=280,WAKE_HEALTH_TIMEOUT_MS=18000,WAKE_SOFT_REFRESH_MS=0,WAKE_FAIL_WINDOW_MS=45000,WAKE_FAIL_THRESHOLD=2,WAKE_ENGINE_COOLDOWN_MS=180000;
const OVERLAY_PUSH_INTERVAL=90,OVERLAY_PUSH_DEBOUNCE=100,DOM_MUTATION_DEBOUNCE=120,DOM_MAINTENANCE_INTERVAL=1500,WAKE_TRANSIENT_ERRORS=new Map([['no-speech',220],['network',1200]]);
const BG_TICK_INTERVAL=800;
const WAKE=/\b(?:hades|ha\s+des|hedes|ades)\b/i;
const WAKE_PREFIX=/^\s*(?:hades|ha\s+des|hedes|ades)[\s,.:;!?-]*/i;
let bgWorker=null,bgTickCallbacks=[];
function initBgWorker(){try{const code='let t=null;onmessage=function(e){if(e.data==="start"){if(t)clearInterval(t);t=setInterval(function(){postMessage("tick");},'+BG_TICK_INTERVAL+');}if(e.data==="stop"){if(t){clearInterval(t);t=null;}}};';const blob=new Blob([code],{type:'application/javascript'});bgWorker=new Worker(URL.createObjectURL(blob));bgWorker.onmessage=()=>{for(const cb of bgTickCallbacks)try{cb();}catch(_){}};bgWorker.postMessage('start');}catch(_){bgWorker=null;}}
function onBgTick(cb){if(typeof cb==='function')bgTickCallbacks.push(cb);}
function guardAudioContext(){const ctx=S.voice.ctx;if(!ctx||ctx.state==='closed')return;if(ctx.state==='suspended')ctx.resume().catch(()=>{});}
const S={settings:{bridgeEnabled:true,autoRun:true,voiceEnabled:true},backendOk:false,backendError:null,spotify:null,prompt:'',promptVersion:'',processed:new WeakSet(),seen:new Map(),exec:false,programmatic:false,voice:{cfg:false,key:'',wakeWord:'HADES',locale:'tr-TR',mode:'idle',err:'',stream:null,ctx:null,worklet:null,src:null,an:null,frame:0,wake:null,wakeStopping:false,recognizer:null,cmd:null,cmdOptions:null,wEpoch:0,cEpoch:0,restart:0,timeout:0,hardTimeout:0,wakeAck:0,wakeHandoff:0,wakeStartedAt:0,wakePulseAt:0,lastNativeStopAt:0,nativeWakeHistory:[],nativeWakeCooldownUntil:0,pageWakeHistory:[],pageWakeCooldownUntil:0,segments:[],interim:'',reply:null,speaking:false,speakingAt:0,lastSig:'',prefVoice:null,ttsEpoch:0,ttsAbort:null,audioEl:null,audioUrl:'',finalizing:false,lastSubmitSig:'',lastSubmitSession:'',lastSubmitAt:0,overlaySig:'',overlayAt:0,overlayTimer:0,meterValue:0,instanceId:(crypto?.randomUUID?crypto.randomUUID():`hades-${Date.now()}-${Math.random().toString(16).slice(2)}`),owner:false,ownerBeat:0,ownerRetry:0,replyWs:null,wakeWs:null,dgWake:null,nativeWakeSupported:false,contextReady:false,bootedAt:Date.now()},alert:{active:null,lastPollAt:0,lastSig:'',repeatTimer:0,loopEpoch:0,syncing:false},logs:[]};
let root,panel,hud,chips,logEl,toastHost,voiceLine,hudState,hudDetail,meter,hudMeter,voiceBtn,cockpitBtn,hideBtn,cbBridge,cbAuto,obs,timer,domTimer=0,domQueued=false,wakeBridgeBound=false,manualScheduleBound=false;
let _wakeAt=0,_cmdTimeoutAt=0,_lastDomTick=0;
const LOGO_URL=chrome.runtime.getURL('hades-cover.png');
function ensureBrandAssets(){const apply=(rel)=>{let link=document.head.querySelector(`link[rel="${rel}"]`);if(!link){link=document.createElement('link');link.rel=rel;document.head.appendChild(link);}if(link.href!==LOGO_URL)link.href=LOGO_URL;};apply('icon');apply('shortcut icon');apply('apple-touch-icon');}
const log=(m)=>{S.logs.unshift(`[${new Date().toLocaleTimeString('tr-TR')}] ${m}`);S.logs=S.logs.slice(0,14);if(logEl){logEl.innerHTML='';S.logs.forEach(t=>{const p=document.createElement('p');p.textContent=t;logEl.appendChild(p);});}};
const chip=(t,tone)=>{const e=document.createElement('span');e.className='hades-bridge-chip';e.dataset.tone=tone;e.textContent=t;return e;};
const voiceMeta=()=>{if(S.alert.active)return{chip:S.alert.active.kind==='reminder'?'Hatırlatıcı çalıyor':'Alarm çalıyor',tone:'warn',detail:S.alert.active.detail||'Yerel zamanlayıcı aktif.'};if(!S.settings.voiceEnabled)return{chip:'Ses kapalı',tone:'warn',detail:'Ses akışı kapalı.'};if(S.voice.err)return{chip:'Ses hatası',tone:'warn',detail:S.voice.err};if(!S.voice.cfg)return{chip:'Ses hazırlanıyor',tone:'warn',detail:'Ses altyapısı hazırlanıyor.'};if(S.voice.mode==='starting')return{chip:'Ses başlıyor',tone:'warn',detail:`"${S.voice.wakeWord}" için mikrofon açılıyor.`};if(S.voice.mode==='wake')return{chip:'Wake dinliyor',tone:'ok',detail:`"${S.voice.wakeWord}" deyince seni dinleyecek.`};if(S.voice.mode==='command')return{chip:'Komut dinliyor',tone:'ok',detail:'Deepgram komutunu dinliyor, bitince mesajı gönderecek.'};if(S.voice.mode==='followup')return{chip:'Seni dinliyor',tone:'ok',detail:'Yanıttan sonra birkaç saniye daha seni bekliyor.'};if(S.voice.mode==='reply')return{chip:'Yanıt bekliyor',tone:'ok',detail:'HADES yanıtını bekliyor.'};if(S.voice.mode==='speaking'){const localTtsActive=shouldUseNativeBackgroundVoice()||(!hasPersistentDesktopShell()&&!!S.voice.replyWs),persistentShell=hasPersistentDesktopShell();return{chip:'Yanıtı okuyor',tone:'ok',detail:localTtsActive?'Yerel Windows sesi aktif. Yeniden "HADES" diyerek kesebilirsin.':(persistentShell?'Uygulama sesi aktif. Yeniden "HADES" diyerek kesebilirsin.':'Chromium sesi aktif. Yeniden "HADES" diyerek kesebilirsin.')};}return{chip:'Ses hazır',tone:'ok',detail:`"${S.voice.wakeWord}" deyince dinlemeye başlayacak.`};};
const overlayState=()=>{const vm=voiceMeta();return{chip:vm.chip,tone:vm.tone,detail:vm.detail,mode:S.voice.mode||'idle',meter:Math.max(0,Math.min(100,Math.round(Number(S.voice.meterValue)||0)))};};
async function postOverlay(force=false){const payload=overlayState(),sig=JSON.stringify(payload),now=Date.now();if(!force&&sig===S.voice.overlaySig)return;S.voice.overlaySig=sig;S.voice.overlayAt=now;for(const base of BACKENDS){try{await fetch(`${base}/bridge/voice-overlay-state`,{method:'POST',headers:{'Content-Type':'application/json'},body:sig});break;}catch(_){}}}
const setMeters=(width='0%')=>{const raw=String(width||'').replace('%','').trim();S.voice.meterValue=Math.max(0,Math.min(100,Number(raw)||0));if(meter)meter.style.width=width;if(hudMeter)hudMeter.style.width=width;void postOverlay(false);};
const render=()=>{if(!chips)return;const spotifyAuthenticated=Boolean(S.spotify?.authenticated??S.spotify?.ready),spotifyDeviceReady=Boolean(S.spotify?.deviceReady),spotifyChip=spotifyDeviceReady?'Spotify hazır':(spotifyAuthenticated?'Spotify cihaz bekliyor':'Spotify girişi bekliyor');chips.innerHTML='';chips.appendChild(chip(S.backendOk?'Backend hazır':'Backend kapalı',S.backendOk?'ok':'warn'));chips.appendChild(chip(S.settings.bridgeEnabled?'AI köprüsü açık':'AI köprüsü kapalı',S.settings.bridgeEnabled?'ok':'warn'));chips.appendChild(chip(spotifyChip,spotifyDeviceReady?'ok':'warn'));const vm=voiceMeta();chips.appendChild(chip(vm.chip,vm.tone));if(voiceLine){voiceLine.textContent=vm.detail;voiceLine.dataset.tone=vm.tone;}if(hud){hud.dataset.tone=vm.tone;hud.dataset.mode=S.voice.mode||'idle';}if(hudState)hudState.textContent=vm.chip;if(hudDetail)hudDetail.textContent=vm.detail;if(voiceBtn)voiceBtn.textContent=S.settings.voiceEnabled?'Sesi Durdur':'Sesi Başlat';if(cbBridge)cbBridge.checked=!!S.settings.bridgeEnabled;if(cbAuto)cbAuto.checked=!!S.settings.autoRun;if(S.voice.mode!=='command')setMeters('0%');void postOverlay(false);};
async function hideDesktopWindow(){try{window.dispatchEvent(new CustomEvent('hades-desktop-bridge',{detail:{action:'hide-main-window'}}));toast('HADES gizlendi. HUD üzerinden geri açabilirsin.','ok');}catch(_){toast('Pencere gizlenemedi.','warn');}}
async function openOpsCockpit(){try{window.dispatchEvent(new CustomEvent('hades-desktop-bridge',{detail:{action:'open-ops-cockpit'}}));toast('Ops cockpit aciliyor.','ok');}catch(_){toast('Ops cockpit acilamadi.','warn');}}
async function minimizeOpsCockpit(){try{window.dispatchEvent(new CustomEvent('hades-desktop-bridge',{detail:{action:'minimize-ops-cockpit'}}));toast('Ops cockpit küçültüldü.','ok');return{ok:true};}catch(_){toast('Ops cockpit küçültülemedi.','warn');return{ok:false,error:'Ops cockpit küçültülemedi.'};}}
async function getOpsCockpitStatus(){try{return await (window.HADESDesktop?.getOpsCockpitState?window.HADESDesktop.getOpsCockpitState():Promise.resolve({ok:false,error:'Ops cockpit durumu alinamadi.'}));}catch(_){return{ok:false,error:'Ops cockpit durumu alinamadi.'};}}
function alertSig(alert=null){if(!alert||typeof alert!=='object'||alert.active===false)return'';return JSON.stringify([alert.id||'',alert.kind||'',alert.time||'',alert.message||'',alert.spokenText||'',alert.triggeredAtISO||'']);}
function clearAlertLoop(){if(S.alert.repeatTimer){clearTimeout(S.alert.repeatTimer);S.alert.repeatTimer=0;}S.alert.loopEpoch+=1;}
async function dismissActiveAlert(reason=''){const active=S.alert.active;if(!active)return;clearAlertLoop();S.alert.active=null;render();try{if(active.id)await bridge({type:'bridge:dismiss-active-alert',id:active.id});S.alert.lastSig='';}catch(_){S.alert.active=active;S.alert.lastSig=alertSig(active);render();startAlertLoop();return;}if(reason)log(reason);}
function cleanupReminderSpeechMessage(text=''){return String(text||'').replace(/^\s*(?:hatirlatma|hatırlatma|hatirlatmam|hatırlatmam|hatirlatici|hatırlatıcı)\s*[:,-]?\s*/iu,'').replace(/\s+/g,' ').trim();}
function activeAlertSpeechText(alert=null){if(!alert||typeof alert!=='object')return'Uyan babacığım, vakit geldi.';if(String(alert.kind||'')==='reminder'){const clean=cleanupReminderSpeechMessage(String(alert.message||''));return clean?`Hatırlatmam: ${clean}`:'Hatırlatmam var.';}return alert.spokenText||alert.detail||'Uyan babacığım, vakit geldi.';}
function startAlertLoop(){const active=S.alert.active;if(!active||!S.settings.voiceEnabled)return;clearAlertLoop();const epoch=S.alert.loopEpoch;const tick=()=>{if(epoch!==S.alert.loopEpoch)return;const current=S.alert.active;if(!current||!S.settings.voiceEnabled)return;if(S.voice.reply)S.voice.reply=null;cancelSpeech();if(!S.voice.recognizer&&!S.voice.cmd)void startWake('speaking_interrupt');speak(activeAlertSpeechText(current),()=>{if(epoch!==S.alert.loopEpoch||!S.alert.active||!S.settings.voiceEnabled)return;S.alert.repeatTimer=setTimeout(tick,ALERT_REPEAT_DELAY);},{interruptible:false});};tick();}
async function applyActiveAlert(alert){const next=alert&&typeof alert==='object'&&alert.active!==false?alert:null,nextSig=alertSig(next),sameSig=nextSig===S.alert.lastSig;if(sameSig&&Boolean(S.alert.active)===Boolean(next)){S.alert.active=next;render();return;}clearAlertLoop();S.alert.active=next;S.alert.lastSig=nextSig;render();if(!next)return;if(S.voice.cmd)await stopCmd(true);S.voice.reply=null;log(next.kind==='reminder'?'Hatırlatıcı zamanı geldi.':'Alarm zamanı geldi.');startAlertLoop();}
async function syncActiveAlert(force=false){if(S.alert.syncing)return;const now=Date.now();if(!force&&now-S.alert.lastPollAt<ALERT_SYNC_INTERVAL)return;S.alert.lastPollAt=now;S.alert.syncing=true;try{const res=await bridge({type:'bridge:get-active-alert'});await applyActiveAlert(res?.ok?res.alert:null);}catch(_){ }finally{S.alert.syncing=false;}}
const ui=()=>{if(root){if(!root.isConnected&&document.documentElement)document.documentElement.appendChild(root);render();return;}root=document.createElement('div');root.id='hades-bridge-host';const shadow=root.attachShadow({mode:'open'}),styleLink=document.createElement('link'),shellRoot=document.createElement('div');styleLink.rel='stylesheet';styleLink.href=chrome.runtime.getURL('bridge.css');shellRoot.id='hades-bridge-root';const tog=document.createElement('button');tog.id='hades-bridge-toggle';tog.type='button';tog.textContent='HDS';tog.onclick=()=>panel.dataset.open=String(panel.dataset.open!=='true');hud=document.createElement('aside');hud.id='hades-voice-hud';hud.innerHTML='<p class="hades-voice-hud-kicker">HADES Ses</p><strong class="hades-voice-hud-state" data-role="hud-state"></strong><p class="hades-voice-hud-detail" data-role="hud-detail"></p><div class="hades-voice-hud-meter"><span data-role="hud-meter"></span></div>';panel=document.createElement('section');panel.id='hades-bridge-panel';panel.dataset.open='true';panel.innerHTML=`<div class="hades-bridge-header"><div class="hades-bridge-brand"><img class="hades-bridge-logo" src="${LOGO_URL}" alt="HADES logo"/><div class="hades-bridge-brand-copy"><p class="hades-bridge-kicker">HADES Oturumu</p><h2 class="hades-bridge-title">HADES</h2></div></div><p class="hades-bridge-subtitle">Normal ChatGPT sohbeti, AI tool çağrıları, Google speech wake word, Deepgram komut ve Chromium sesi tek akışta.</p></div><div class="hades-bridge-body"><div class="hades-bridge-chip-row" data-role="chips"></div><div class="hades-bridge-actions"><button type="button" data-a="context">Promptu Gönder</button><button type="button" data-a="voice" data-style="secondary">Sesi Başlat</button><button type="button" data-a="refresh" data-style="secondary">Durumu Yenile</button><button type="button" data-a="spotify" data-style="secondary">Spotify Bağla</button><button type="button" data-a="cockpit" data-style="secondary">Ops Cockpit</button><button type="button" data-a="hide" data-style="secondary">Pencereyi Gizle</button></div><div class="hades-bridge-voice-card"><div class="hades-bridge-voice-status" data-role="voice"></div><div class="hades-bridge-voice-meter"><span data-role="meter"></span></div></div><div class="hades-bridge-toggle-row"><label><input type="checkbox" data-s="bridgeEnabled"/> Köprü aktif</label><span>Sadece AI ürettiği araçlar çalışır</span></div><div class="hades-bridge-toggle-row"><label><input type="checkbox" data-s="autoRun"/> Otomatik çalıştır</label><span>Tool JSON çıkınca direkt uygula</span></div><div class="hades-bridge-log" data-role="log"></div></div>`;
chips=panel.querySelector('[data-role="chips"]');logEl=panel.querySelector('[data-role="log"]');voiceLine=panel.querySelector('[data-role="voice"]');hudState=hud.querySelector('[data-role="hud-state"]');hudDetail=hud.querySelector('[data-role="hud-detail"]');meter=panel.querySelector('[data-role="meter"]');hudMeter=hud.querySelector('[data-role="hud-meter"]');voiceBtn=panel.querySelector('[data-a="voice"]');cockpitBtn=panel.querySelector('[data-a="cockpit"]');hideBtn=panel.querySelector('[data-a="hide"]');cbBridge=panel.querySelector('input[data-s="bridgeEnabled"]');cbAuto=panel.querySelector('input[data-s="autoRun"]');toastHost=document.createElement('div');toastHost.id='hades-bridge-toast-host';panel.querySelector('[data-a="context"]').onclick=()=>void sendContext();panel.querySelector('[data-a="refresh"]').onclick=()=>void refresh(true);panel.querySelector('[data-a="spotify"]').onclick=()=>void spotifyLogin();if(cockpitBtn)cockpitBtn.onclick=()=>void openOpsCockpit();if(hideBtn)hideBtn.onclick=()=>void hideDesktopWindow();voiceBtn.onclick=()=>void setSetting('voiceEnabled',!S.settings.voiceEnabled);cbBridge.onchange=()=>void setSetting('bridgeEnabled',cbBridge.checked);cbAuto.onchange=()=>void setSetting('autoRun',cbAuto.checked);shellRoot.append(hud,tog,panel,toastHost);shadow.append(styleLink,shellRoot);document.documentElement.appendChild(root);render();};
const brand=()=>{if(root&&!root.isConnected&&document.documentElement)document.documentElement.appendChild(root);if(document.title!=='HADES')document.title='HADES';document.documentElement.setAttribute('data-hades-shell','true');};
const bridge=async(m)=>{const res=await chrome.runtime.sendMessage(m);if(res?.ok===false&&res?.error){const type=String(m?.type||'type_yok');console.warn('[HADES bridge error]',type,res.error);}return res;};
chrome.runtime.onMessage.addListener((message,_,sendResponse)=>{if(String(message?.type||'')!=='hades:desktop-action')return;const action=String(message?.action||'').trim();(async()=>{switch(action){case'open-ops-cockpit':await openOpsCockpit();sendResponse({ok:true,action});return;case'minimize-ops-cockpit':sendResponse(await minimizeOpsCockpit());return;case'ops-cockpit-status':sendResponse(await getOpsCockpitStatus());return;default:sendResponse({ok:false,error:`Bilinmeyen desktop action: ${action}`});}})().catch(error=>sendResponse({ok:false,error:error?.message||String(error)}));return true;});
function emitWakeControl(detail={}){window.postMessage({__hadesWakeBridge:true,direction:'to-page',...detail},'*');}
function clearWakeAck(){if(!S.voice.wakeAck)return;clearTimeout(S.voice.wakeAck);S.voice.wakeAck=0;}
function clearWakeHandoff(){if(!S.voice.wakeHandoff)return;clearTimeout(S.voice.wakeHandoff);S.voice.wakeHandoff=0;}
function logWakeStarted(){const now=Date.now();if(now-Number(S.voice.lastWakeStartLogAt||0)<1800)return;S.voice.lastWakeStartLogAt=now;log('Wake-word motoru dinlemeye başladı.');}
function wakeEngineKey(kind=''){const value=String(kind||'').trim();if(value==='native'||value==='native-bridge')return'native';if(value==='page'||value==='page-bridge')return'page';if(value==='deepgram'||value==='deepgram-wake')return'deepgram';return'';}
function wakeFailureHistoryKey(engine=''){return wakeEngineKey(engine)==='page'?'pageWakeHistory':'nativeWakeHistory';}
function wakeCooldownKey(engine=''){return wakeEngineKey(engine)==='page'?'pageWakeCooldownUntil':'nativeWakeCooldownUntil';}
function clearWakeEngineFailures(engine=''){const normalized=wakeEngineKey(engine);if(!normalized||normalized==='deepgram')return;const next=globalThis.HADESWakeStrategy?.clearWakeFailures?globalThis.HADESWakeStrategy.clearWakeFailures():{history:[],cooldownUntilMs:0};S.voice[wakeFailureHistoryKey(normalized)]=next.history;S.voice[wakeCooldownKey(normalized)]=next.cooldownUntilMs;}
function isWakeEngineCoolingDown(engine=''){const normalized=wakeEngineKey(engine);if(!normalized||normalized==='deepgram')return false;if(globalThis.HADESWakeStrategy?.isWakeEngineCoolingDown)return globalThis.HADESWakeStrategy.isWakeEngineCoolingDown({nowMs:Date.now(),cooldownUntilMs:S.voice[wakeCooldownKey(normalized)]});return Number(S.voice[wakeCooldownKey(normalized)]||0)>Date.now();}
function markWakeEngineFailure(engine='',reason=''){const normalized=wakeEngineKey(engine);if(!normalized||normalized==='deepgram')return false;const currentHistory=Array.isArray(S.voice[wakeFailureHistoryKey(normalized)])?S.voice[wakeFailureHistoryKey(normalized)]:[];const result=globalThis.HADESWakeStrategy?.registerWakeFailure?globalThis.HADESWakeStrategy.registerWakeFailure({nowMs:Date.now(),history:currentHistory,cooldownUntilMs:S.voice[wakeCooldownKey(normalized)],windowMs:WAKE_FAIL_WINDOW_MS,threshold:WAKE_FAIL_THRESHOLD,cooldownMs:WAKE_ENGINE_COOLDOWN_MS}):{history:[...currentHistory,Date.now()],cooldownUntilMs:Number(S.voice[wakeCooldownKey(normalized)]||0),tripped:false};S.voice[wakeFailureHistoryKey(normalized)]=result.history;S.voice[wakeCooldownKey(normalized)]=result.cooldownUntilMs;if(result.tripped){log(`${normalized==='native'?'Yerel':'Sayfa'} wake motoru dengesizleşti (${reason||'unstable'}). Alternatif Google STT wake motoru denenecek.`);}return result.tripped;}
function preferredWakeEngine(reason='manual'){if(globalThis.HADESWakeStrategy?.pickWakeEngine)return globalThis.HADESWakeStrategy.pickWakeEngine({preferNative:shouldUseNativeDesktopWake(reason),preferPage:shouldUseFreePageWake(reason),deepgramAvailable:false,nativeCoolingDown:isWakeEngineCoolingDown('native'),pageCoolingDown:isWakeEngineCoolingDown('page')});if(shouldUseNativeDesktopWake(reason)&&!isWakeEngineCoolingDown('native'))return'native';if(shouldUseFreePageWake(reason)&&!isWakeEngineCoolingDown('page'))return'page';return'';}
function touchWakeHealth(started=false){const now=Date.now();if(started||!S.voice.wakeStartedAt)S.voice.wakeStartedAt=now;S.voice.wakePulseAt=now;}
function resetWakeHealth(){S.voice.wakeStartedAt=0;S.voice.wakePulseAt=0;}
async function maybeRefreshWakeHealth(){
    if(!S.settings.voiceEnabled||S.voice.cmd||S.voice.reply||S.voice.speaking||S.voice.wakeStarting||S.voice.wakeStopping)return;
    const now=Date.now();
    if(hasLiveWakeSession(now))return;
    const current=S.voice.wake;
    if(current){
        if(current.kind==='native-bridge')closeWakeWs();
        if(current.kind==='deepgram-wake'&&S.voice.dgWake){
            try{S.voice.dgWake.close();}catch(_){}
            S.voice.dgWake=null;
        }
        clearWakeSession(current);
        resetWakeHealth();
        if(!S.voice.cmd&&!S.voice.reply&&!S.voice.speaking){
            S.voice.mode='idle';
            render();
        }
    }
    if(!_wakeAt)scheduleWake(250);
}
async function waitForWakeBridgeReady(timeoutMs=WAKE_READY_TIMEOUT){const startedAt=Date.now();while(Date.now()-startedAt<timeoutMs){if(document.documentElement.dataset.hadesWakeBridge==='ready')return true;await sleep(50);}return document.documentElement.dataset.hadesWakeBridge==='ready';}
async function ensureWakeBridge(){if(document.documentElement.dataset.hadesWakeBridge==='ready')return true;const res=await bridge({type:'bridge:ensure-wake-main-world'});if(!res?.ok)throw new Error(res?.error||'Wake-word köprüsü yüklenemedi.');if(await waitForWakeBridgeReady())return true;document.documentElement.dataset.hadesWakeBridge='';const retry=await bridge({type:'bridge:ensure-wake-main-world'});if(!retry?.ok)throw new Error(retry?.error||'Wake-word köprüsü ikinci denemede yüklenemedi.');if(await waitForWakeBridgeReady())return true;throw new Error('Wake-word köprüsü hazır sinyali vermedi.');}
function bindWakeBridge(){
    if(wakeBridgeBound)return;
    wakeBridgeBound=true;
    window.addEventListener('message',(event)=>{
        if(event.source!==window)return;
        const detail=event.data||{};
        if(!detail.__hadesWakeBridge||detail.direction!=='to-content')return;
        const type=String(detail.type||'');
        const epoch=Number(detail.epoch)||0;
        const current=S.voice.wake;
        const matches=current&&current.kind==='page-bridge'&&Number(current.epoch)===epoch;
        if(type==='ready'){
            document.documentElement.dataset.hadesWakeBridge='ready';
            return;
        }
        if(type==='unsupported'){
            clearWakeAck();
            clearWakeHandoff();
            markWakeEngineFailure('page','unsupported');
            if(matches)clearWakeSession(current);
            resetWakeHealth();
            S.voice.err='Tarayıcı wake-word motoru desteklenmiyor.';
            render();
            log(S.voice.err);
            return;
        }
        if(!matches)return;
        if(type==='started'){
            clearWakeAck();
            clearWakeHandoff();
            clearWakeEngineFailures('page');
            touchWakeHealth(true);
            if(!S.voice.speaking)S.voice.mode='wake';
            S.voice.err='';
            render();
            logWakeStarted();
            return;
        }
        if(type==='heartbeat'){
            touchWakeHealth(false);
            return;
        }
        if(type==='wake'){
            clearWakeAck();
            clearWakeHandoff();
            clearWakeEngineFailures('page');
            touchWakeHealth(false);
            void onWake(String(detail.transcript||S.voice.wakeWord),{inlineCommand:String(detail.command||''),sessionKey:`page:${epoch||Date.now()}`});
            return;
        }
        if(type==='error'){
            const err=String(detail.error||'unknown');
            clearWakeAck();
            clearWakeHandoff();
            clearWakeSession(current);
            resetWakeHealth();
            if(err==='aborted'&&S.voice.wakeStopping)return;
            if(WAKE_TRANSIENT_ERRORS.has(err)){
                if(!S.voice.speaking)S.voice.mode='idle';
                render();
                scheduleWake(WAKE_TRANSIENT_ERRORS.get(err)||WAKE_RESTART);
                return;
            }
            markWakeEngineFailure('page',err);
            S.voice.err=err==='not-allowed'||err==='service-not-allowed'?'Mikrofon izni gerekli.':`Wake-word hatası: ${err}`;
            render();
            log(S.voice.err);
            if(err!=='not-allowed'&&err!=='service-not-allowed')scheduleWake(420);
            return;
        }
        if(type==='ended'){
            clearWakeAck();
            clearWakeHandoff();
            clearWakeSession(current);
            resetWakeHealth();
            if(S.voice.wakeStopping)return;
            if(!S.voice.cmd&&!S.voice.reply&&S.settings.voiceEnabled){
                if(!S.voice.speaking)S.voice.mode='idle';
                render();
                scheduleWake(220);
            }
        }
    });
}
const hasPersistentDesktopShell=()=>document.documentElement?.dataset?.hadesDesktopShell==='electron'||document.documentElement?.dataset?.hadesPersistentBackground==='true'||window.HADESDesktop?.isDesktop===true;
const isParkedDesktopShell=()=>document.documentElement?.dataset?.hadesParked==='true';
const isHiddenDesktopShell=()=>document.documentElement?.dataset?.hadesWindowHidden==='true';
const voiceContextGracePending=()=>!hasPersistentDesktopShell()&&!S.voice.contextReady&&Date.now()-S.voice.bootedAt<VOICE_CONTEXT_STARTUP_GRACE_MS;
function syncVoiceContextReady(){if(S.voice.contextReady)return true;if(hasPersistentDesktopShell()){S.voice.contextReady=true;return true;}if(!voiceContextGracePending()){S.voice.contextReady=true;return true;}return false;}
async function waitForDesktopShellContext(timeoutMs=DESKTOP_SHELL_WAIT_TIMEOUT_MS){if(hasPersistentDesktopShell())return true;const limit=Math.max(200,Number(timeoutMs)||DESKTOP_SHELL_WAIT_TIMEOUT_MS),startedAt=Date.now();while(Date.now()-startedAt<limit){await sleep(80);if(hasPersistentDesktopShell())return true;}return hasPersistentDesktopShell();}
const isForegroundVoiceContext=()=>hasPersistentDesktopShell()?true:(voiceContextGracePending()?true:document.visibilityState!=='hidden');
const isBackgroundVoiceContext=()=>hasPersistentDesktopShell()?false:(!voiceContextGracePending()&&document.visibilityState==='hidden');
function wakeSocketLive(socket=null){return!!socket&&(socket.readyState===WebSocket.OPEN||socket.readyState===WebSocket.CONNECTING);}
function wakePulseFresh(now=Date.now()){const pulseAt=Math.max(Number(S.voice.wakePulseAt||0),Number(S.voice.wakeStartedAt||0));return pulseAt>0&&(now-pulseAt)<=WAKE_HEALTH_TIMEOUT_MS;}
function activeWakeKind(){const current=S.voice.wake||S.voice.recognizer;return current&&typeof current==='object'&&current.kind?String(current.kind).trim():'';}
function shouldForceNativeWake(){return !!S.voice.nativeWakeSupported&&!shouldUseNativeBackgroundVoice();}
function shouldUseDeepgramWake(reason='manual'){void reason;return false;}
function hasLiveWakeSession(now=Date.now()){
    const current=S.voice.wake;
    if(!current||S.voice.recognizer!==current)return false;
    if(current.kind==='deepgram-wake')return shouldUseDeepgramWake()&&wakeSocketLive(S.voice.dgWake);
    if(current.kind==='native-bridge'){
        if(!wakeSocketLive(S.voice.wakeWs))return false;
        if(S.voice.mode==='starting'&&!Number(S.voice.wakeStartedAt||0))return true;
        return wakePulseFresh(now);
    }
    if(current.kind==='page-bridge'){
        const pulseAt=Math.max(Number(S.voice.wakePulseAt||0),Number(S.voice.wakeStartedAt||0));
        return pulseAt>0&&(now-pulseAt)<=WAKE_HEALTH_TIMEOUT_MS;
    }
    return false;
}
function isWakeSessionCurrent(session){return!!session&&S.voice.wake===session&&S.voice.recognizer===session;}
function clearWakeSession(session=null){
    if(!session||S.voice.wake===session)S.voice.wake=null;
    if(!session||S.voice.recognizer===session)S.voice.recognizer=null;
}
const ownerVisible=()=>hasPersistentDesktopShell()?true:isForegroundVoiceContext();
const shouldUseNativeBackgroundVoice=()=>false;
function stopOwnerHeartbeat(){if(S.voice.ownerBeat){clearInterval(S.voice.ownerBeat);S.voice.ownerBeat=0;}}
function scheduleOwnerClaim(ms=VOICE_OWNER_RETRY){if(S.voice.ownerRetry)clearTimeout(S.voice.ownerRetry);S.voice.ownerRetry=setTimeout(()=>{S.voice.ownerRetry=0;void claimVoiceOwner('retry');},ms);}
async function releaseVoiceOwner(){stopOwnerHeartbeat();if(S.voice.ownerRetry){clearTimeout(S.voice.ownerRetry);S.voice.ownerRetry=0;}try{await bridge({type:'bridge:release-voice-owner',instanceId:S.voice.instanceId,visible:ownerVisible()});}catch(_){}S.voice.owner=false;}
async function relinquishVoice(){stopSchedule();clearCmd();S.voice.reply=null;S.voice.err='';cancelSpeech();await stopWake(true);await stopCmd(true);await dispose(true);S.voice.mode=S.settings.voiceEnabled?'idle':'off';render();}
function startOwnerHeartbeat(){if(S.voice.ownerBeat)return;S.voice.ownerBeat=setInterval(async()=>{let r=null;try{r=await bridge({type:'bridge:heartbeat-voice-owner',instanceId:S.voice.instanceId,visible:ownerVisible()});}catch(_){}if(r?.ok&&r.owner)return;stopOwnerHeartbeat();if(S.voice.owner){S.voice.owner=false;await relinquishVoice();}scheduleOwnerClaim();},VOICE_OWNER_HEARTBEAT);}
async function claimVoiceOwner(reason='manual'){if(!S.settings.voiceEnabled)return false;if(S.voice.owner){startOwnerHeartbeat();return true;}if(S.voice.ownerRetry){clearTimeout(S.voice.ownerRetry);S.voice.ownerRetry=0;}let r=null;try{r=await bridge({type:'bridge:claim-voice-owner',instanceId:S.voice.instanceId,visible:ownerVisible()});}catch(_){}if(r?.ok&&r.owner){const became=!S.voice.owner;S.voice.owner=true;S.voice.err='';startOwnerHeartbeat();if(became&&(reason==='manual'||reason==='bootstrap'||reason==='focus'))log('Ses yetkisi bu pencereye alindi.');render();return true;}if(S.voice.owner){S.voice.owner=false;await relinquishVoice();}scheduleOwnerClaim();render();return false;}
async function ensureVoiceOwner(reason='manual'){if(!S.settings.voiceEnabled)return false;if(!ownerVisible()){if(S.voice.owner)await releaseVoiceOwner();return false;}return claimVoiceOwner(reason);}
async function setSetting(key,val){const r=await bridge({type:'bridge:set-settings',patch:{[key]:val}});if(!r?.ok){log(r?.error||'Ayar kaydedilemedi.');return;}S.settings=r.settings;render();if(key==='voiceEnabled'){if(val){toast('Ses akışı açıldı.','ok');await syncActiveAlert(true);if(!S.alert.active)await startWake('setting');}else{toast('Ses akışı kapatıldı.','warn');clearAlertLoop();await releaseVoiceOwner();await stopVoice('setting');}}}
async function refresh(manual=false){const r=await bridge({type:'bridge:get-runtime-status'});if(!r?.ok){S.backendOk=false;S.backendError=r?.error||'Durum alınamadı.';render();if(manual)log(S.backendError);return;}S.backendOk=!!r.backendOk;S.spotify=r.spotify;S.backendError=r.backendError||null;render();if(manual)log(S.backendOk?'Backend durumu yenilendi.':(S.backendError||'Backend kapalı.'));}
async function loadSettings(){const r=await bridge({type:'bridge:get-settings'});if(r?.ok&&r.settings)S.settings=r.settings;render();}
async function loadContext(){const r=await bridge({type:'bridge:get-context-prompt'});if(!r?.ok)throw new Error(r?.error||'Bridge context alınamadı.');S.prompt=String(r.prompt||'');S.promptVersion=String(r.context?.version||'');return S.prompt;}
async function loadVoiceCfg(){let r=await bridge({type:'bridge:get-voice-config'});if(!r?.ok){for(const base of BACKENDS){try{const res=await fetch(`${base}/bridge/voice-config`);if(!res.ok)continue;r=await res.json();break;}catch(_){}}}if(!r||r.ok===false)r={deepgramConfigured:false,deepgramApiKey:'',wakeWord:'HADES',locale:'tr-TR',nativeWakeSupported:false,degraded:true};S.voice.cfg=true;S.voice.err='';S.voice.key=String(r.deepgramApiKey||'').trim();S.voice.wakeWord=String(r.wakeWord||'HADES').trim()||'HADES';S.voice.locale=String(r.locale||'tr-TR').trim()||'tr-TR';S.voice.nativeWakeSupported=!!r.nativeWakeSupported;render();return r;}
function wakeRecognitionCtor(){return window.SpeechRecognition||window.webkitSpeechRecognition||null;}
function shouldUseFreePageWake(reason='manual'){void reason;return !shouldUseNativeBackgroundVoice()&&!shouldForceNativeWake()&&!!wakeRecognitionCtor();}
function shouldUseNativeDesktopWake(reason='manual'){void reason;return hasPersistentDesktopShell()&&!!S.voice.nativeWakeSupported;}
function shouldPreferFastPageWake(reason='manual'){const key=String(reason||'');if(!shouldUseFreePageWake(reason))return false;return new Set(['focus','followup_idle','empty_transcript','duplicate_transcript','no_speech']).has(key);}
function wakeAckLeadMs(text=''){const cleaned=norm(text);if(cleaned.includes('efendim babacigim'))return 1220;if(cleaned.includes('dinliyorum babacigim'))return 1080;return 0;}
function wakeStartAckTimeoutMs(reason='manual'){const key=String(reason||'');if(!shouldUseFreePageWake(reason))return WAKE_START_ACK_TIMEOUT;if(new Set(['bootstrap','manual','setting']).has(key))return BOOTSTRAP_WAKE_START_ACK_TIMEOUT;return shouldPreferFastPageWake(reason)?FAST_WAKE_START_ACK_TIMEOUT:WAKE_START_ACK_TIMEOUT;}
function wakeHandoffDelayMs(reason='manual'){return String(reason||'')==='followup_idle'?FOLLOWUP_WAKE_HANDOFF_MS:FAST_WAKE_HANDOFF_MS;}
function dgWakeConnectTimeoutMs(reason='manual'){return String(reason||'').startsWith('followup_idle')?FOLLOWUP_DG_WAKE_CONNECT_TIMEOUT:DG_WAKE_CONNECT_TIMEOUT;}
async function spotifyLogin(){const r=await bridge({type:'bridge:open-spotify-login'});log(r?.ok?(r.message||'Spotify bağlantı penceresi açıldı.'):(r?.error||'Spotify bağlanamadı.'));await refresh(false);}
async function sendContext(){try{await sendChat(await loadContext());log('HADES proje promptu sohbete gönderildi.');}catch(e){log(e.message||'Prompt gönderilemedi.');}}
const composer=()=>document.querySelector('#prompt-textarea')||document.querySelector('div[contenteditable="true"][id="prompt-textarea"]')||document.querySelector('textarea[data-testid="textbox"]')||document.querySelector('textarea');
async function waitComposer(t=20000){const s=Date.now();while(Date.now()-s<t){const c=composer();if(c)return c;await sleep(250);}throw new Error('HADES mesaj kutusu bulunamadı.');}
function put(c,text){if(!c)return;c.focus();if(c.tagName==='TEXTAREA'){c.value=text;c.dispatchEvent(new Event('input',{bubbles:true}));c.dispatchEvent(new Event('change',{bubbles:true}));return;}try{document.execCommand('selectAll',false);document.execCommand('insertText',false,text);}catch(_){}if(String(c.textContent||'').trim()!==String(text||'').trim()){c.innerHTML='';const p=document.createElement('p');p.textContent=text;c.appendChild(p);}c.dispatchEvent(new InputEvent('input',{bubbles:true,data:text,inputType:'insertText'}));c.dispatchEvent(new Event('change',{bubbles:true}));}
function composerText(c=composer()){if(!c)return'';return cleanupSpaces(c.tagName==='TEXTAREA'?String(c.value||''):String(c.textContent||''));}
function clearComposer(c=composer()){if(!c)return;put(c,'');}
const sendBtn=()=>document.querySelector('button[data-testid="send-button"]')||document.querySelector('button[aria-label^="Send"]')||document.querySelector('button[aria-label*="Gonder"]')||document.querySelector('button[aria-label*="Gönder"]');
const stopBtn=()=>document.querySelector('button[data-testid="stop-button"]')||document.querySelector('button[aria-label^="Stop"]')||document.querySelector('button[aria-label*="Durdur"]')||document.querySelector('button[aria-label*="Yanitlamayi durdur"]')||document.querySelector('button[aria-label*="Yanıtlamayı durdur"]');
async function stopAnswer(){const b=stopBtn();if(!b||b.disabled)return false;b.click();await sleep(120);log('Model yanıtı durduruldu.');return true;}
async function clickSend(){const s=Date.now();while(Date.now()-s<5000){const b=sendBtn();if(b&&!b.disabled){b.click();return true;}await sleep(150);}const c=composer();if(c){c.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));return true;}return false;}
async function sendChat(text){S.programmatic=true;try{const c=await waitComposer();put(c,text);await sleep(180);if(!(await clickSend()))throw new Error('Mesaj gönderilemedi.');}finally{setTimeout(()=>{S.programmatic=false;},250);}}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const toast=(m,t='info')=>{if(!toastHost)return;const e=document.createElement('div');e.className='hades-bridge-toast';e.dataset.tone=t;e.textContent=m;toastHost.appendChild(e);setTimeout(()=>{e.classList.add('is-leaving');setTimeout(()=>e.remove(),320);},3200);};
function cleanupSpaces(text=''){return String(text||'').replace(/\s+/g,' ').trim();}
function extractDirectScheduleIntent(text=''){if(globalThis.HADESScheduleIntent?.extractLocalScheduleIntent)return globalThis.HADESScheduleIntent.extractLocalScheduleIntent(text);return null;}
async function runDirectLocalIntent(rawText,source='voice'){const cleaned=cleanupSpaces(rawText);const intent=extractDirectScheduleIntent(cleaned);if(!intent)return false;S.exec=true;try{await stopAnswer();log(`Yerel zamanlayıcı komutu doğrudan işlendi: ${intent.tool}`);const r=await bridge({type:'bridge:execute-actions',actions:[intent]});const results=Array.isArray(r?.results)&&r.results.length?r.results.map(x=>({tool:x.tool,ok:x.ok,status:x.status||null,data:x.data||null,error:x.error||null})):[{tool:intent.tool,ok:false,status:null,data:null,error:r?.error||'Yerel araç sonucu alınamadı.'}];S.voice.reply={count:speakableAssistant().length,started:Date.now(),sig:'',stable:0,pendingSince:0};S.voice.mode='reply';render();if(shouldUseNativeBackgroundVoice())void startBackendReplyWatch();await sendChat(['HADES_TOOL_RESULT',JSON.stringify({ok:results.every(x=>x.ok),source,directLocalIntent:true,userCommand:cleaned,results},null,2)].join('\n'));log('Yerel zamanlayıcı sonucu sohbete geri yazıldı.');await refresh(false);return true;}catch(e){S.voice.reply=null;S.voice.err=e.message||'Yerel zamanlayıcı komutu gönderilemedi.';render();log(S.voice.err);if(source==='voice'&&S.settings.voiceEnabled)await startWake('send_failed');return true;}finally{S.exec=false;}}
function bindManualScheduleInterceptors(){if(manualScheduleBound)return;manualScheduleBound=true;document.addEventListener('keydown',(event)=>{if(S.programmatic||event.defaultPrevented||event.isComposing||event.key!=='Enter'||event.shiftKey)return;const c=composer();if(!c)return;const target=event.target;if(target!==c&&!(target&&typeof c.contains==='function'&&c.contains(target)))return;const raw=composerText(c);if(!extractDirectScheduleIntent(raw))return;event.preventDefault();event.stopImmediatePropagation();clearComposer(c);void runDirectLocalIntent(raw,'typed');},true);document.addEventListener('click',(event)=>{if(S.programmatic||event.defaultPrevented)return;const target=event.target;if(!target||typeof target.closest!=='function')return;const btn=target.closest('button[data-testid="send-button"],button[aria-label^="Send"],button[aria-label*="Gonder"],button[aria-label*="Gönder"]');if(!btn)return;const c=composer();const raw=composerText(c);if(!extractDirectScheduleIntent(raw))return;event.preventDefault();event.stopImmediatePropagation();clearComposer(c);void runDirectLocalIntent(raw,'typed');},true);}
function initVoices(){if(!('speechSynthesis' in window))return;const vs=window.speechSynthesis.getVoices();S.voice.prefVoice=vs.find(v=>v.name==='Google Türkçe'&&v.lang==='tr-TR')||vs.find(v=>v.lang==='tr-TR')||null;window.speechSynthesis.onvoiceschanged=initVoices;}
function stripSpeechPayloads(text=''){if(globalThis.HADESVoiceOutput?.stripSpeechPayloads)return globalThis.HADESVoiceOutput.stripSpeechPayloads(text);let out=String(text||'');out=out.replace(/```(?:hades-bridge|json)?[\s\S]*?```/gi,' ');while(out.includes('"actions"')){const i=out.indexOf('"actions"'),o=out.lastIndexOf('{',i);if(o<0)break;const chunk=balanced(out,o);if(!chunk)break;out=`${out.slice(0,o)} ${out.slice(o+chunk.length)}`;}return out;}
function stripEmoji(text=''){return String(text||'').replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F]/gu,' ');}
function collapseRepeat(text=''){const clean=String(text||'').replace(/\s+/g,' ').trim();if(!clean)return'';const words=clean.split(' ');if(words.length>=4&&words.length%2===0){const half=words.length/2,left=words.slice(0,half).join(' '),right=words.slice(half).join(' ');if(norm(left)===norm(right))return left;}return clean;}
function speechText(text=''){if(globalThis.HADESVoiceOutput?.normalizeSpeechText)return globalThis.HADESVoiceOutput.normalizeSpeechText(text);return collapseRepeat(stripEmoji(stripSpeechPayloads(String(text||'')).replace(/HADES_TOOL_RESULT[\s\S]*$/gi,' ').replace(/HADES_RUNTIME_STATUS[\s\S]*$/gi,' ').replace(/HADES_LOCAL_EXECUTION[\s\S]*$/gi,' ').replace(/HADES_BRIDGE_PROFILE_V\d+/gi,' '))).replace(/\s+/g,' ').trim();}
function stripAssistantAckPrefix(text=''){const raw=String(text||'').trim();if(!raw)return'';const tokens=raw.split(/\s+/).filter(Boolean),normalized=tokens.map((token)=>norm(token)),patterns=[['efendim','babacigim'],['dinliyorum','babacigim'],['efendim'],['dinliyorum']];for(const pattern of patterns){if(pattern.length>normalized.length)continue;let matches=true;for(let i=0;i<pattern.length;i+=1){if(normalized[i]!==pattern[i]){matches=false;break;}}if(matches)return tokens.slice(pattern.length).join(' ').replace(/^[,.:;!?-]+/,'').trim();}return raw;}
function settledVoiceMode(fallback='idle'){if(S.voice.reply)return'reply';if(S.voice.cmd)return S.voice.cmdOptions?.mode==='followup'?'followup':'command';if(S.voice.recognizer||S.voice.dgWake)return'wake';return S.settings.voiceEnabled?fallback:'off';}
function isContinuousNativeWakeActive(){return activeWakeKind()==='native-bridge'&&wakeSocketLive(S.voice.wakeWs)&&S.voice.wake===S.voice.recognizer;}
function cancelSpeech(reason=''){S.voice.ttsEpoch+=1;if('speechSynthesis' in window)try{window.speechSynthesis.cancel();}catch(_){}for(const base of BACKENDS){fetch(`${base}/bridge/tts/stop`,{method:'POST'}).catch(()=>{});}if(S.voice.speaking){S.voice.speaking=false;S.voice.speakingAt=0;S.voice.mode=settledVoiceMode('idle');render();}if(reason)log(reason);}
function speak(text,onEnd=null,opts={}){const m=speechText(text),id=S.voice.ttsEpoch+1,interruptible=opts.interruptible!==false;if(!m){if(onEnd)onEnd();return;}if(shouldUseNativeBackgroundVoice()){S.voice.ttsEpoch=id;S.voice.speaking=true;S.voice.speakingAt=Date.now();S.voice.mode='speaking';render();(async()=>{try{for(const base of BACKENDS){try{const r=await fetch(`${base}/bridge/tts/speak`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:m,locale:S.voice.locale||'tr-TR'})});if(r.ok)break;}catch(_){}}}catch(_){}if(id!==S.voice.ttsEpoch)return;S.voice.speaking=false;S.voice.speakingAt=0;S.voice.mode=settledVoiceMode('idle');render();if(onEnd)onEnd();})();if(interruptible&&S.settings.voiceEnabled)setTimeout(()=>{if(id===S.voice.ttsEpoch&&S.voice.speaking&&!S.voice.recognizer&&!S.voice.cmd)void startWake('speaking_interrupt');},320);return;}if(!('speechSynthesis' in window)){if(onEnd)onEnd();return;}try{S.voice.ttsEpoch=id;window.speechSynthesis.cancel();S.voice.speaking=true;S.voice.speakingAt=Date.now();S.voice.mode='speaking';render();const u=new SpeechSynthesisUtterance(m);u.lang=S.voice.locale||'tr-TR';u.rate=1.02;u.pitch=1;if(S.voice.prefVoice)u.voice=S.voice.prefVoice;u.onend=()=>{if(id!==S.voice.ttsEpoch)return;S.voice.speaking=false;S.voice.speakingAt=0;S.voice.mode=settledVoiceMode('idle');render();if(onEnd)onEnd();};u.onerror=()=>{if(id!==S.voice.ttsEpoch)return;S.voice.speaking=false;S.voice.speakingAt=0;S.voice.err='Tarayıcı sesi oynatılamadı.';S.voice.mode=settledVoiceMode('idle');render();if(onEnd)onEnd();};window.speechSynthesis.speak(u);if(interruptible&&S.settings.voiceEnabled)setTimeout(()=>{if(id===S.voice.ttsEpoch&&S.voice.speaking&&!S.voice.recognizer&&!S.voice.cmd)void startWake('speaking_interrupt');},320);}catch(_){S.voice.speaking=false;S.voice.mode=settledVoiceMode('idle');render();if(onEnd)onEnd();}}
function speakChunk(text,onEnd=null){const m=speechText(text);if(!m){if(onEnd)onEnd();return;}if(shouldUseNativeBackgroundVoice()){S.voice.speaking=true;S.voice.speakingAt=Date.now();S.voice.mode='speaking';render();(async()=>{try{for(const base of BACKENDS){try{const r=await fetch(`${base}/bridge/tts/speak`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:m,locale:S.voice.locale||'tr-TR'})});if(r.ok)break;}catch(_){}}}catch(_){}S.voice.speaking=false;S.voice.speakingAt=0;S.voice.mode=settledVoiceMode('idle');render();if(onEnd)onEnd();})();return;}if(!('speechSynthesis' in window)){if(onEnd)onEnd();return;}const id=S.voice.ttsEpoch;S.voice.speaking=true;S.voice.speakingAt=Date.now();S.voice.mode='speaking';render();const u=new SpeechSynthesisUtterance(m);u.lang=S.voice.locale||'tr-TR';u.rate=1.02;u.pitch=1;if(S.voice.prefVoice)u.voice=S.voice.prefVoice;u.onend=()=>{if(id!==S.voice.ttsEpoch)return;if(!window.speechSynthesis.pending&&!window.speechSynthesis.speaking){S.voice.speaking=false;S.voice.speakingAt=0;S.voice.mode=settledVoiceMode('idle');render();}if(onEnd)onEnd();};u.onerror=()=>{if(id!==S.voice.ttsEpoch)return;if(!window.speechSynthesis.pending&&!window.speechSynthesis.speaking){S.voice.speaking=false;S.voice.speakingAt=0;S.voice.mode=settledVoiceMode('idle');render();}if(onEnd)onEnd();};window.speechSynthesis.speak(u);if(S.settings.voiceEnabled&&!S.voice.recognizer)setTimeout(()=>{if(id===S.voice.ttsEpoch&&S.voice.speaking&&!S.voice.recognizer&&!S.voice.cmd)void startWake('speaking_interrupt');},320);}
function extractSpeakChunks(text,opts={}){if(globalThis.HADESVoiceOutput?.extractStreamingChunks)return globalThis.HADESVoiceOutput.extractStreamingChunks(text,opts);const results=[],re=/[^.!?…\n]+(?:[.!?…]+|\n)\s*/g;let m,consumed=0;while((m=re.exec(text))!==null){results.push(m[0].trim());consumed=re.lastIndex;}return{chunks:results.filter(Boolean),consumed};}
function sig(text){let h=0;const n=String(text||'');for(let i=0;i<n.length;i+=1){h=((h<<5)-h)+n.charCodeAt(i);h|=0;}return `${n.length}:${h}`;}
function parsePayload(text){const t=String(text||'').trim();if(!t.startsWith('{')||!t.includes('"actions"'))return null;try{const p=JSON.parse(t);return Array.isArray(p.actions)&&p.actions.length?p:null;}catch(_){return null;}}
function balanced(text,start){let d=0,s=false,e=false;for(let i=start;i<text.length;i+=1){const c=text[i];if(s){if(e){e=false;continue;}if(c==='\\'){e=true;continue;}if(c==='"')s=false;continue;}if(c==='"'){s=true;continue;}if(c==='{'){d+=1;continue;}if(c==='}'){d-=1;if(d===0)return text.slice(start,i+1);}}return '';}
function payloadFrom(text){const raw=String(text||'').trim();if(!raw.includes('"actions"'))return null;for(const m of raw.matchAll(/```(?:hades-bridge|json)\s*([\s\S]*?)```/gi)){const p=parsePayload(m[1]||'');if(p)return p;}if(raw.startsWith('{')&&raw.endsWith('}'))return parsePayload(raw);const i=raw.indexOf('"actions"');if(i>=0){const o=raw.lastIndexOf('{',i);if(o>=0){const p=parsePayload(balanced(raw,o));if(p)return p;}}return null;}
function hideTech(text){const t=String(text||'').trim();if(!t)return false;if(t.startsWith('HADES_BRIDGE_PROFILE_V'))return true;if(t.includes('Çalışma protokolü:')&&t.includes('Kullanabileceğin yerel araçlar:'))return true;if(t.startsWith('HADES_TOOL_RESULT')||t.startsWith('HADES_RUNTIME_STATUS')||t.startsWith('HADES_LOCAL_EXECUTION'))return true;const p=payloadFrom(t);if(!p)return false;return t.replace(/```(?:hades-bridge|json)?/gi,'').replace(/```/g,'').trim().length<2000;}
function assistantNodes(){return [...document.querySelectorAll('[data-message-author-role="assistant"],article[data-message-author-role="assistant"]')];}
function messageNodes(){return [...document.querySelectorAll('[data-message-author-role],article')];}
function seed(){messageNodes().forEach(n=>{S.processed.add(n);n.querySelectorAll('pre code').forEach(c=>S.processed.add(c));});}
function decorate(){messageNodes().forEach(n=>{const t=String(n.textContent||'').trim();if(hideTech(t))n.classList.add('hades-bridge-hidden-message');});}
function speechSourceFromNode(node){if(!node||typeof node.cloneNode!=='function')return String(node?.textContent||'');try{const clone=node.cloneNode(true);clone.querySelectorAll('pre,code,button,svg,style,script,textarea,input,select,canvas,audio,video,noscript,[aria-hidden="true"],[data-testid*="copy"],[data-testid*="popover"],[data-testid*="citation"]').forEach((el)=>el.remove());return String(clone.textContent||'');}catch(_){return String(node.textContent||'');}}
function assistantSpeechText(node){return speechText(speechSourceFromNode(node));}
function speakableAssistant(){return assistantNodes().filter(n=>{const raw=String(n.textContent||'').trim(),spoken=assistantSpeechText(n);return !!raw&&!!spoken&&!hideTech(raw);});}
async function scanBridge(){if(!S.settings.bridgeEnabled||S.exec)return;const candidates=[...assistantNodes().flatMap(n=>Array.from(n.querySelectorAll('pre code'))),...assistantNodes()];for(const c of candidates){if(S.processed.has(c))continue;const text=String(c.textContent||'');if(text.startsWith('HADES_BRIDGE_PROFILE_V')||(text.includes('Çalışma protokolü:')&&text.includes('Kullanabileceğin yerel araçlar:'))){S.processed.add(c);continue;}const payload=payloadFrom(text);if(!payload)continue;const s=sig(JSON.stringify(payload));const last=S.seen.get(s);const now=Date.now();S.seen.set(s,now);for(const [k,v] of S.seen.entries())if(now-v>20000)S.seen.delete(k);S.processed.add(c);if(last&&now-last<15000)continue;if(!S.settings.autoRun){const ok=window.confirm(`HADES Bridge bu araçları çalıştırsın mı?\n${payload.actions.map(a=>a.tool).join(', ')}`);if(!ok){log('Araç çağrısı kullanıcı tarafından iptal edildi.');continue;}}await execBridge(payload);break;}}
async function execBridge(payload){S.exec=true;try{await stopAnswer();log(`Araç çağrısı yakalandı: ${payload.actions.map(a=>a.tool).join(', ')}`);if((payload.actions||[]).some(a=>/^browser\./.test(String(a?.tool||a?.name||''))))await openOpsCockpit();const r=await bridge({type:'bridge:execute-actions',actions:payload.actions});if(!r?.results)throw new Error(r?.error||'Araç sonucu alınamadı.');const results=r.results.map(x=>({tool:x.tool,ok:x.ok,status:x.status||null,data:x.data||null,error:x.error||null}));await sendChat(['HADES_TOOL_RESULT',JSON.stringify({ok:!!r.ok,results},null,2)].join('\n'));log('Yerel araç sonucu sohbete geri yazıldı.');await refresh(false);}catch(e){log(e.message||'Araç çağrısı işlenemedi.');}finally{S.exec=false;}}
function norm(text=''){if(globalThis.HADESWakeWord?.norm)return globalThis.HADESWakeWord.norm(text);return String(text||'').toLocaleLowerCase('tr-TR').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\u0131/g,'i').replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim();}
function wakeTokenMatch(token=''){if(globalThis.HADESWakeWord?.wakeTokenMatch)return globalThis.HADESWakeWord.wakeTokenMatch(token);const t=norm(token);if(!t)return false;if(['hades','hedes','ades','hadesi','hadesin','hadesim','hds','hadese','hadesya'].includes(t))return true;if(t.startsWith('hades')||t.startsWith('ades')||t.startsWith('hede'))return true;const chars=t.replace(/\s+/g,'');if(chars.length<3||chars.length>7)return false;let score=0;if(chars.includes('h'))score+=1;if(chars.includes('a'))score+=1;if(chars.includes('d'))score+=1;if(chars.includes('e'))score+=1;if(chars.includes('s'))score+=1;return score>=4;}
function hasWake(text=''){if(globalThis.HADESWakeWord?.hasWake)return globalThis.HADESWakeWord.hasWake(text);const cleaned=norm(text);if(!cleaned)return false;if(/\b(hades|ha des|hedes|ades)\b/.test(cleaned))return true;return cleaned.split(' ').some(wakeTokenMatch);}
function isWakeOnly(text=''){if(globalThis.HADESWakeWord?.isWakeOnly)return globalThis.HADESWakeWord.isWakeOnly(text);const cleaned=norm(text);if(!cleaned||!hasWake(cleaned))return false;const rest=cleaned.split(' ').filter((part)=>!wakeTokenMatch(part)).join(' ').trim();return !rest;}
function stripWake(text=''){if(globalThis.HADESWakeWord?.stripWake)return globalThis.HADESWakeWord.stripWake(text);const raw=String(text||'').trim();if(!raw)return'';const p=raw.replace(WAKE_PREFIX,'').trim();if(p!==raw)return p;const m=raw.match(WAKE);if(!m||m.index===undefined)return raw;return raw.slice(m.index+m[0].length).replace(/^[\s,.:;!?-]+/,'').trim();}
function extractWakeCommand(text=''){if(globalThis.HADESWakeWord?.extractWakeCommand)return globalThis.HADESWakeWord.extractWakeCommand(text);return stripWake(text);}
function normalizeVoiceSubmitSessionKey(sessionKey=''){if(globalThis.HADESVoiceSession?.normalizeSessionKey)return globalThis.HADESVoiceSession.normalizeSessionKey(sessionKey);const normalized=String(sessionKey||'').trim();return normalized||'default';}
function shouldSuppressVoiceSubmit(submitSig='',sessionKey='default'){const payload={submitSig:String(submitSig||'').trim(),sessionKey:normalizeVoiceSubmitSessionKey(sessionKey),lastSubmitSig:S.voice.lastSubmitSig,lastSubmitSessionKey:S.voice.lastSubmitSession,lastSubmitAtMs:S.voice.lastSubmitAt,nowMs:Date.now(),windowMs:1600};if(!payload.submitSig)return false;if(globalThis.HADESVoiceSession?.shouldSuppressDuplicateSubmission)return globalThis.HADESVoiceSession.shouldSuppressDuplicateSubmission(payload);return payload.submitSig===String(payload.lastSubmitSig||'').trim()&&payload.sessionKey===normalizeVoiceSubmitSessionKey(payload.lastSubmitSessionKey)&&payload.nowMs-payload.lastSubmitAtMs>=0&&payload.nowMs-payload.lastSubmitAtMs<=payload.windowMs;}
function rememberVoiceSubmit(submitSig='',sessionKey='default'){S.voice.lastSubmitSig=String(submitSig||'').trim();S.voice.lastSubmitSession=normalizeVoiceSubmitSessionKey(sessionKey);S.voice.lastSubmitAt=Date.now();}
function closeReplyWs(){const ws=S.voice.replyWs;S.voice.replyWs=null;if(ws&&(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING))try{ws.close();}catch(_){}}
function closeWakeWs(target=null){const ws=target||S.voice.wakeWs;if(!ws)return;if(!target||S.voice.wakeWs===target)S.voice.wakeWs=null;if(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING)try{ws.close();}catch(_){}}
async function startBackendReplyWatch(){closeReplyWs();if(!S.voice.reply||!S.settings.voiceEnabled)return;const p=S.voice.reply,instanceId=S.voice.instanceId,baselineSig=p.sig||'';for(const base of BACKENDS){try{await fetch(`${base}/bridge/reply-watch/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instanceId,baselineCount:p.count,baselineSig,timeoutMs:REPLY_TIMEOUT})});break;}catch(_){}}const wsBase=BACKENDS[0].replace(/^http/,'ws');try{const ws=new WebSocket(`${wsBase}/bridge/reply-events?instanceId=${encodeURIComponent(instanceId)}`);S.voice.replyWs=ws;ws.onmessage=(e)=>{let d;try{d=JSON.parse(e.data);}catch(_){return;}if(d.instanceId&&d.instanceId!==instanceId)return;if(d.type==='bridge:reply-speaking'){S.voice.speaking=true;S.voice.mode='speaking';render();log('Backend yanıtı seslendiriyor (arka plan).');}if(d.type==='bridge:reply-handled'){S.voice.speaking=false;S.voice.reply=null;S.voice.lastSig=d.sig||'';S.voice.mode=settledVoiceMode('idle');render();closeReplyWs();log('Backend yanıtı seslendirdi.');if(S.settings.voiceEnabled)void startFollowupListening('reply_done');}if(d.type==='bridge:reply-timeout'){S.voice.reply=null;S.voice.mode=settledVoiceMode('idle');render();closeReplyWs();if(S.settings.voiceEnabled)void startWake('reply_timeout');}};ws.onerror=()=>{closeReplyWs();};ws.onclose=()=>{S.voice.replyWs=null;};}catch(_){}}
async function startFollowupListening(reason='reply_done'){if(!S.settings.voiceEnabled)return;if(S.voice.recognizer||S.voice.dgWake)await prepareWakeForCommand('idle');await startCmd(reason,{mode:'followup',silentNoSpeech:true,timeoutMs:FOLLOWUP_TIMEOUT,hardTimeoutMs:FOLLOWUP_TIMEOUT,activityMinChars:2,waitForSpeechEnd:false});}
async function stopBackendReplyWatch(){closeReplyWs();for(const base of BACKENDS){try{await fetch(`${base}/bridge/reply-watch/stop`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instanceId:S.voice.instanceId})});break;}catch(_){}}}
async function stopNativeWakeBridge(sessionId=''){const requestedSessionId=String(sessionId||S.voice.wake?.sessionId||S.voice.recognizer?.sessionId||'').trim();closeWakeWs();for(const base of BACKENDS){try{await fetch(`${base}/bridge/wake-listener/stop`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instanceId:S.voice.instanceId,sessionId:requestedSessionId})});break;}catch(_){}}}
async function migrateWakeToNative(reason='native_migrate'){
    if(!shouldForceNativeWake()||S.voice.wakeStarting||S.voice.wakeStopping||S.voice.cmd||S.voice.reply||S.voice.speaking)return false;
    const current=S.voice.wake;
    if(!current||current.kind!=='page-bridge')return false;
    await stopWake(true,'idle');
    return startWake(reason);
}
async function startNativeWake(reason='manual'){
    if(!S.settings.voiceEnabled||S.voice.cmd||S.voice.reply)return false;
    const current=S.voice.wake;
    if(current&&current.kind==='native-bridge'&&hasLiveWakeSession()){
        clearWakeAck();
        S.voice.err='';
        if(!S.voice.speaking)S.voice.mode='wake';
        render();
        return true;
    }
    if(current&&current.kind!=='native-bridge')return false;
    const epoch=++S.voice.wEpoch;
    const sessionId=`native:${S.voice.instanceId}:${epoch}:${Date.now()}`;
    const overlay=S.voice.speaking||reason==='speaking_interrupt';
    const softRestart=new Set(['restart','focus','reply_timeout','empty_reply','duplicate_reply','empty_transcript','duplicate_transcript','command_error','followup_idle','no_speech']).has(String(reason||''));
    const session={kind:'native-bridge',epoch,sessionId,reason,stop(){void stopNativeWakeBridge(sessionId);}};
    const wsBase=BACKENDS[0].replace(/^http/,'ws');
    let socketSettled=false;
    const settleSocket=()=>{if(socketSettled)return false;socketSettled=true;return true;};
    const cleanupNative=(restartDelay=0,err='')=>{
        if(isWakeSessionCurrent(session))clearWakeSession(session);
        closeWakeWs();
        resetWakeHealth();
        if(err)S.voice.err=err;
        if(!S.voice.speaking)S.voice.mode='idle';
        render();
        if(restartDelay>0&&S.settings.voiceEnabled&&!S.voice.cmd&&!S.voice.reply)scheduleWake(restartDelay);
    };
    S.voice.lastWakeEngine='native';
    await waitForNativeWakeSettle();
    if(!overlay&&!softRestart&&S.voice.mode!=='wake')S.voice.mode='starting';
    S.voice.wake=session;
    S.voice.recognizer=session;
    resetWakeHealth();
    render();
    try{
        const ws=new WebSocket(`${wsBase}/bridge/wake-events?instanceId=${encodeURIComponent(S.voice.instanceId)}`);
        S.voice.wakeWs=ws;
        ws.onopen=async()=>{
            if(!isWakeSessionCurrent(session)){closeWakeWs(ws);return;}
            await sleep(180);
            let started=false;
            for(const base of BACKENDS){
                try{
                    const res=await fetch(`${base}/bridge/wake-listener/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instanceId:S.voice.instanceId,sessionId,locale:S.voice.locale||'tr-TR',wakeWord:S.voice.wakeWord||'HADES'})});
                    if(!res.ok)continue;
                    let payload=null;
                    try{payload=await res.json();}catch(_){}
                    if(payload?.sessionId&&String(payload.sessionId)!==sessionId)continue;
                    started=true;
                    break;
                }catch(_){}
            }
            if(!started){
                markWakeEngineFailure('native','start_rejected');
                cleanupNative(700,'Yerel wake servisi başlatılamadı.');
            }
        };
        ws.onmessage=(e)=>{
            if(!isWakeSessionCurrent(session))return;
            let d;
            try{d=JSON.parse(e.data);}catch(_){return;}
            if(d.instanceId&&d.instanceId!==S.voice.instanceId)return;
            if(d.sessionId&&String(d.sessionId)!==sessionId)return;
            if(d.type==='heartbeat'){touchWakeHealth(false);return;}
            if(d.type==='started'){
                clearWakeAck();
                clearWakeEngineFailures('native');
                touchWakeHealth(true);
                if(!S.voice.speaking)S.voice.mode='wake';
                S.voice.err='';
                render();
                logWakeStarted();
                return;
            }
            if(d.type==='wake'){
                clearWakeAck();
                clearWakeEngineFailures('native');
                touchWakeHealth(false);
                if(S.voice.cmd||(S.voice.reply&&!S.voice.speaking)){
                    return;
                }
                void onWake(String(d.transcript||S.voice.wakeWord),{inlineCommand:String(d.command||''),sessionKey:`native:${epoch}`});
                return;
            }
            if(d.type==='bridge:wake-error'){
                const message=String(d.message||'Yerel wake hatası.');
                const recoverable=!!d.recoverable;
                clearWakeAck();
                if(S.voice.wakeStopping||/aborted/i.test(message))return;
                if(recoverable){
                    touchWakeHealth(false);
                    S.voice.err='';
                    if(!S.voice.speaking)S.voice.mode='wake';
                    render();
                    log(`Wake motoru kısa süreli hata verdi, toparlanıyor: ${message}`);
                    return;
                }
                markWakeEngineFailure('native',message);
                cleanupNative(700,message);
                return;
            }
            if(d.type==='bridge:wake-closed'){
                clearWakeAck();
                if(S.voice.wakeStopping)return;
                cleanupNative(450);
            }
        };
        ws.onerror=()=>{
            if(!settleSocket())return;
            if(S.voice.wakeStopping)return;
            cleanupNative(700);
        };
        ws.onclose=()=>{
            if(!settleSocket())return;
            if(S.voice.wakeStopping)return;
            cleanupNative(450);
        };
        const nativeAckTimeout=new Set(['bootstrap','manual','setting']).has(String(reason||''))?9000:6500;
        S.voice.wakeAck=setTimeout(()=>{
            if(!isWakeSessionCurrent(session)||S.voice.mode!=='starting')return;
            markWakeEngineFailure('native','ack_timeout');
            cleanupNative(800,'Yerel wake dinleme zamanında hazır olmadı.');
        },nativeAckTimeout);
        if(reason==='manual'||reason==='bootstrap'||reason==='focus'||reason==='setting')log(`Wake-word dinleme aktif: "${S.voice.wakeWord}"`);
        return true;
    }catch(e){
        markWakeEngineFailure('native','start_failed');
        cleanupNative(700,e.message||'Yerel wake dinleme başlatılamadı.');
        return false;
    }
}
async function watchReplies(){const p=S.voice.reply;if(!p||S.exec||S.alert.active)return;if(shouldUseNativeBackgroundVoice())return;const nodes=speakableAssistant();if(nodes.length<=p.count){if(Date.now()-p.started>REPLY_TIMEOUT){log('Sesli yanıt bekleme zaman aşımına uğradı.');S.voice.reply=null;if(S.settings.voiceEnabled)await startWake('reply_timeout');}return;}const fullTxt=assistantSpeechText(nodes[nodes.length-1]);const isStreaming=!!stopBtn();if(!fullTxt){if(!isStreaming){S.voice.reply=null;if(S.settings.voiceEnabled)await startWake('empty_reply');}return;}p.spokenLen=Math.max(0,Math.min(Number(p.spokenLen)||0,fullTxt.length));if(isStreaming){const unspoken=fullTxt.slice(p.spokenLen);if(unspoken.trim()&&!p.pendingSince)p.pendingSince=Date.now();const{chunks,consumed}=extractSpeakChunks(unspoken,{pendingSinceMs:p.pendingSince||0,nowMs:Date.now(),waitMs:STREAM_CHUNK_WAIT_MS,minChars:STREAM_CHUNK_MIN_CHARS,softChars:STREAM_CHUNK_SOFT_CHARS,maxChars:STREAM_CHUNK_MAX_CHARS});if(chunks.length>0&&!(shouldUseNativeBackgroundVoice()&&S.voice.speaking)){const toSpeak=chunks.join(' ');p.spokenLen=Math.min(fullTxt.length,p.spokenLen+consumed);p.pendingSince=fullTxt.slice(p.spokenLen).trim()?Date.now():0;speakChunk(toSpeak);}return;}p.pendingSince=0;const s=sig(fullTxt);if(s!==p.sig){p.sig=s;p.stable=Date.now();return;}if(Date.now()-p.stable<REPLY_FINAL_STABLE_MS)return;S.voice.reply=null;void stopBackendReplyWatch();if(S.voice.lastSig===s&&p.spokenLen>=fullTxt.length){if(S.settings.voiceEnabled)await startFollowupListening('duplicate_reply');return;}S.voice.lastSig=s;const remaining=fullTxt.slice(p.spokenLen||0).trim();const returnFollowup=()=>{if(S.settings.voiceEnabled)void startFollowupListening('reply_done');};if(remaining){log('HADES yanıtının kalanı seslendiriliyor.');speakChunk(remaining,returnFollowup);}else if(!S.voice.speaking){returnFollowup();}else{const ep=S.voice.ttsEpoch;const poll=()=>{if(ep!==S.voice.ttsEpoch||!S.voice.speaking){returnFollowup();return;}setTimeout(poll,200);};setTimeout(poll,200);}}
function runDomMaintenance(){domQueued=false;if(domTimer){clearTimeout(domTimer);domTimer=0;}ui();brand();decorate();void scanBridge();void watchReplies();void syncActiveAlert();}
function queueDomMaintenance(delay=DOM_MUTATION_DEBOUNCE){if(domQueued)return;domQueued=true;domTimer=setTimeout(runDomMaintenance,delay);}
function observe(){if(obs)return;seed();decorate();obs=new MutationObserver(()=>queueDomMaintenance());obs.observe(document.documentElement,{childList:true,subtree:true});}
async function mic(){if(S.voice.stream&&S.voice.stream.active)return S.voice.stream;S.voice.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});return S.voice.stream;}
async function worklet(){if(!S.voice.ctx)return false;const code=`class R extends AudioWorkletProcessor{constructor({processorOptions:{targetSampleRate,inputSampleRate}}){super();this.t=targetSampleRate;this.i=inputSampleRate;}process(inputs){const d=inputs[0][0];if(d)this.port.postMessage(this.down(d));return true;}down(b){const r=this.i/this.t,l=Math.max(1,Math.round(b.length/r)),o=new Int16Array(l);let or=0,ob=0;while(or<l){const n=Math.round((or+1)*r);let a=0,c=0;for(let i=ob;i<n&&i<b.length;i+=1){a+=b[i];c+=1;}o[or]=Math.max(-1,Math.min(1,c>0?(a/c):0))*0x7FFF;or+=1;ob=n;}return o.buffer;}}registerProcessor('resampler-processor',R);`;const blob=new Blob([code],{type:'application/javascript'});const url=URL.createObjectURL(blob);try{await S.voice.ctx.audioWorklet.addModule(url);return true;}finally{URL.revokeObjectURL(url);}}
async function dispose(stopStream=false){if(S.voice.frame){cancelAnimationFrame(S.voice.frame);S.voice.frame=0;}if(S.voice.worklet){try{S.voice.worklet.port.postMessage('stop');S.voice.worklet.disconnect();}catch(_){}S.voice.worklet=null;}if(S.voice.an){try{S.voice.an.disconnect();}catch(_){}S.voice.an=null;}if(S.voice.src){try{S.voice.src.disconnect();}catch(_){}S.voice.src=null;}const ctx=S.voice.ctx;S.voice.ctx=null;if(ctx&&ctx.state!=='closed'){try{await ctx.close();}catch(_){}}if(stopStream&&S.voice.stream){for(const t of S.voice.stream.getTracks())try{t.stop();}catch(_){}S.voice.stream=null;}setMeters('0%');}
function audio(stream,socket,isOpen,showMeter=false){if(!S.voice.ctx)return;S.voice.src=S.voice.ctx.createMediaStreamSource(stream);S.voice.an=S.voice.ctx.createAnalyser();S.voice.an.fftSize=256;const len=S.voice.an.frequencyBinCount,data=new Uint8Array(len);S.voice.worklet=new AudioWorkletNode(S.voice.ctx,'resampler-processor',{processorOptions:{targetSampleRate:16000,inputSampleRate:S.voice.ctx.sampleRate}});S.voice.worklet.port.onmessage=(e)=>{if(!isOpen())return;const d=e.data;if(d.byteLength>0&&socket&&socket.readyState===WebSocket.OPEN)socket.send(d);};S.voice.src.connect(S.voice.an);S.voice.src.connect(S.voice.worklet);if(!showMeter){setMeters('0%');return;}const draw=()=>{if(!isOpen()||!S.voice.an){setMeters('0%');return;}S.voice.frame=requestAnimationFrame(draw);S.voice.an.getByteFrequencyData(data);let sum=0;for(let i=0;i<len;i+=1)sum+=data[i];setMeters(`${Math.min(100,(sum/len/128)*100)}%`);};draw();}
async function prep(){await dispose(false);const stream=await mic();S.voice.ctx=new AudioContext();S.voice.ctx.onstatechange=()=>{if(S.voice.ctx&&S.voice.ctx.state==='suspended')S.voice.ctx.resume().catch(()=>{});};await worklet();return stream;}
function clearCmd(){_cmdTimeoutAt=0;if(S.voice.timeout){clearTimeout(S.voice.timeout);S.voice.timeout=0;}if(S.voice.hardTimeout){clearTimeout(S.voice.hardTimeout);S.voice.hardTimeout=0;}}
function scheduleWake(ms=WAKE_RESTART){if(!S.settings.voiceEnabled||S.voice.reply||S.voice.cmd)return;stopSchedule();_wakeAt=Date.now()+ms;}
function stopSchedule(){_wakeAt=0;if(S.voice.restart){clearTimeout(S.voice.restart);S.voice.restart=0;}}
function handoffWake(reason='manual'){if(!S.settings.voiceEnabled)return;clearWakeHandoff();stopSchedule();const delay=Math.max(0,Number(wakeHandoffDelayMs(reason))||0);if(delay<=0){if(!S.voice.cmd&&!S.voice.reply&&!S.voice.speaking)void startWake(reason);return;}if(!S.voice.cmd&&!S.voice.reply&&!S.voice.speaking){S.voice.mode='idle';render();}S.voice.wakeHandoff=setTimeout(()=>{S.voice.wakeHandoff=0;if(!S.settings.voiceEnabled||S.voice.cmd||S.voice.reply||S.voice.speaking)return;void startWake(reason);},delay);}
async function voiceReady(){if(!S.voice.cfg)await loadVoiceCfg();if(!S.voice.key){S.voice.err='DEEPGRAM_API_KEY eksik.';render();return false;}return true;}
async function waitForNativeWakeSettle(minDelayMs=520){const elapsed=Date.now()-Number(S.voice.lastNativeStopAt||0),waitMs=Math.max(0,(Number(minDelayMs)||0)-elapsed);if(waitMs>0)await sleep(waitMs);}
async function prepareWakeForCommand(nextMode='idle'){if(isContinuousNativeWakeActive()){clearWakeAck();clearWakeHandoff();if(!S.voice.speaking){S.voice.mode=nextMode;render();}return false;}await stopWake(true,nextMode);return true;}
async function stopWake(preserve=true,nextMode='idle'){
    stopSchedule();
    clearWakeAck();
    clearWakeHandoff();
    S.voice.wEpoch+=1;
    S.voice.wakeStopping=true;
    const current=S.voice.wake||S.voice.recognizer;
    const currentKind=current?.kind?String(current.kind):'';
    const currentSessionId=String(current?.sessionId||'').trim();
    clearWakeSession(current||null);
    if(currentKind==='deepgram-wake'&&S.voice.dgWake){
        try{S.voice.dgWake.close();}catch(_){}
        S.voice.dgWake=null;
    }
    if(currentKind==='page-bridge'){
        try{emitWakeControl({action:'stop',epoch:Number(current?.epoch)||0});}catch(_){}
    }
    if(current&&currentKind!=='native-bridge'&&currentKind!=='page-bridge'&&typeof current.stop==='function'){
        try{current.stop();}catch(_){}
    }else if(current&&typeof current.close==='function'){
        try{current.close();}catch(_){}
    }
    if(currentKind==='native-bridge'){
        closeWakeWs();
        await stopNativeWakeBridge(currentSessionId).catch(()=>{});
        S.voice.lastNativeStopAt=Date.now();
    }else{
        closeWakeWs();
    }
    resetWakeHealth();
    S.voice.wakeStopping=false;
    if(!preserve)await dispose(true);
    if(!S.voice.cmd&&!S.voice.reply&&!S.voice.speaking&&S.settings.voiceEnabled){
        S.voice.mode=nextMode;
        render();
    }
}
async function stopCmd(preserve=true){S.voice.cEpoch+=1;clearCmd();S.voice.segments=[];S.voice.interim='';S.voice.cmdOptions=null;const s=S.voice.cmd;S.voice.cmd=null;if(s&&(s.readyState===WebSocket.OPEN||s.readyState===WebSocket.CONNECTING))try{s.close();}catch(_){}const shouldStopStream=!preserve||(!S.voice.wake&&!S.voice.reply&&!S.voice.speaking);await dispose(shouldStopStream);if(!S.voice.wake&&!S.voice.reply&&!S.voice.speaking&&S.settings.voiceEnabled){S.voice.mode='idle';render();}}
async function startDgWake(reason='restart'){const current=S.voice.recognizer,currentKind=activeWakeKind();if(!S.settings.voiceEnabled||S.voice.cmd||S.voice.reply||isBackgroundVoiceContext())return false;if(currentKind==='deepgram-wake'&&wakeSocketLive(S.voice.dgWake)&&current===S.voice.wake){clearWakeAck();S.voice.err='';if(!S.voice.speaking)S.voice.mode='wake';render();return true;}if(current&&currentKind&&currentKind!=='deepgram-wake')return false;if(!(await voiceReady()))return false;if(S.voice.dgWake&&!wakeSocketLive(S.voice.dgWake))S.voice.dgWake=null;const overlay=S.voice.speaking||reason==='speaking_interrupt',softRestart=reason==='restart'||reason==='focus'||reason==='reply_timeout'||reason==='empty_reply'||reason==='duplicate_reply'||reason==='empty_transcript'||reason==='duplicate_transcript'||reason==='command_error'||reason==='followup_idle'||reason==='no_speech',epoch=++S.voice.wEpoch,stream=await prep(),socket=new WebSocket(`${DG}?encoding=linear16&sample_rate=16000&language=tr&model=nova-2&endpointing=400&utterance_end_ms=1000&interim_results=true&smart_format=true`,['token',S.voice.key]),session={kind:'deepgram-wake',epoch,reason,socket,stop(){void stopDgWake();}};S.voice.lastWakeEngine='deepgram';if(!overlay&&!softRestart&&S.voice.mode!=='wake')S.voice.mode='starting';S.voice.recognizer=session;S.voice.wake=session;S.voice.dgWake=socket;render();const open=()=>S.settings.voiceEnabled&&S.voice.dgWake===socket&&S.voice.recognizer===session&&!S.voice.cmd&&!S.voice.reply&&!isBackgroundVoiceContext();socket.onopen=()=>{if(!open()){try{socket.close();}catch(_){}return;}S.voice.err='';if(!S.voice.speaking)S.voice.mode='wake';render();log(`Ön plan Deepgram wake dinleme aktif (${reason}).`);audio(stream,socket,open,false);};socket.onmessage=(m)=>{if(!open())return;let d;try{d=JSON.parse(m.data);}catch(_){return;}const t=speechText(String(d.channel?.alternatives?.[0]?.transcript||'').trim());if(!t||!(d.is_final||d.speech_final)||!hasWake(t))return;log(`Deepgram wake-word algılandı: ${t}`);void onWake(t,{inlineCommand:extractWakeCommand(t),sessionKey:`dg:${epoch}`});};socket.onerror=()=>{if(S.voice.dgWake===socket)S.voice.dgWake=null;if(S.voice.recognizer===session)S.voice.recognizer=null;if(S.voice.wake===session)S.voice.wake=null;render();if(S.settings.voiceEnabled&&!S.voice.cmd&&!S.voice.reply&&!isBackgroundVoiceContext())scheduleWake(220);};socket.onclose=()=>{if(S.voice.dgWake===socket)S.voice.dgWake=null;if(S.voice.recognizer===session)S.voice.recognizer=null;if(S.voice.wake===session)S.voice.wake=null;if(S.voice.wakeStopping)return;if(S.settings.voiceEnabled&&!S.voice.cmd&&!S.voice.reply&&!isBackgroundVoiceContext()){if(!S.voice.speaking)S.voice.mode='idle';render();scheduleWake(220);}};return true;}
async function stopDgWake(){const s=S.voice.dgWake;S.voice.dgWake=null;if(s&&(s.readyState===WebSocket.OPEN||s.readyState===WebSocket.CONNECTING))try{s.close();}catch(_){}await dispose(false);}
async function stopVoice(reason='manual'){stopSchedule();clearWakeAck();clearCmd();clearAlertLoop();S.voice.reply=null;S.voice.err='';S.voice.mode='off';cancelSpeech();closeReplyWs();await stopNativeWakeBridge();await stopWake(false);await stopCmd(false);await dispose(true);if(reason!=='setting')log('Ses akışı durduruldu.');render();}
async function pauseHiddenVoice(){stopSchedule();clearWakeAck();clearCmd();S.voice.reply=null;S.voice.err='';cancelSpeech();closeReplyWs();await stopNativeWakeBridge();await stopWake(false);await stopCmd(false);await dispose(true);if(S.settings.voiceEnabled){S.voice.mode='idle';render();}}
async function startPageWake(reason='manual'){
    if(!S.settings.voiceEnabled||S.voice.cmd||S.voice.reply)return false;
    const current=S.voice.wake;
    if(current&&current.kind==='page-bridge'&&hasLiveWakeSession()){
        clearWakeAck();
        S.voice.err='';
        touchWakeHealth(!S.voice.wakeStartedAt);
        if(!S.voice.speaking)S.voice.mode='wake';
        render();
        return true;
    }
    if(current&&current.kind!=='page-bridge')return false;
    bindWakeBridge();
    await ensureWakeBridge();
    const overlay=S.voice.speaking||reason==='speaking_interrupt';
    const softRestart=new Set(['restart','focus','reply_timeout','empty_reply','duplicate_reply','empty_transcript','duplicate_transcript','command_error','followup_idle','no_speech']).has(String(reason||''));
    const epoch=++S.voice.wEpoch;
    const session={kind:'page-bridge',epoch,reason,stop(){emitWakeControl({action:'stop',epoch});}};
    S.voice.lastWakeEngine='page';
    if(!overlay&&!softRestart&&S.voice.mode!=='wake')S.voice.mode='starting';
    S.voice.wake=session;
    S.voice.recognizer=session;
    resetWakeHealth();
    render();
    emitWakeControl({action:'start',epoch,lang:S.voice.locale||'tr-TR',wakeWord:S.voice.wakeWord||'HADES'});
    S.voice.wakeAck=setTimeout(()=>{
        if(!isWakeSessionCurrent(session)||S.voice.mode!=='starting')return;
        markWakeEngineFailure('page','ack_timeout');
        document.documentElement.dataset.hadesWakeBridge='';
        clearWakeSession(session);
        resetWakeHealth();
        if(S.settings.voiceEnabled&&!S.voice.cmd&&!S.voice.reply)scheduleWake(350);
    },wakeStartAckTimeoutMs(reason));
    if(reason==='manual'||reason==='bootstrap'||reason==='focus'||reason==='setting')log(`Wake-word dinleme aktif: "${S.voice.wakeWord}"`);
    return true;
}
async function startWake(reason='manual'){
    if(!S.settings.voiceEnabled||S.voice.wakeStopping||S.voice.wakeStarting||S.voice.cmd||(S.voice.reply&&reason!=='speaking_interrupt'))return false;
    S.voice.wakeStarting=true;
    try{
        if(shouldForceNativeWake()&&!hasPersistentDesktopShell()&&new Set(['bootstrap','focus','setting']).has(String(reason||''))){
            await waitForDesktopShellContext();
        }
        if(!(await ensureVoiceOwner(reason))){
            if(!S.voice.cmd&&!S.voice.reply&&!S.voice.speaking){
                S.voice.mode=S.settings.voiceEnabled?'idle':'off';
                render();
            }
            if(S.settings.voiceEnabled&&new Set(['bootstrap','focus','setting']).has(String(reason||'')))scheduleWake(420);
            return false;
        }
        syncVoiceContextReady();
        stopSchedule();
        clearWakeAck();
        clearWakeHandoff();
        if(hasLiveWakeSession()){
            touchWakeHealth();
            if(!S.voice.speaking)S.voice.mode='wake';
            render();
            return true;
        }
        const current=S.voice.wake||S.voice.recognizer;
        if(current){
            const currentKind=String(current.kind||'');
            const currentSessionId=String(current.sessionId||'').trim();
            clearWakeSession(current);
            if(currentKind==='deepgram-wake'){
                await stopDgWake().catch(()=>{});
            }else if(currentKind==='native-bridge'){
                closeWakeWs();
                await stopNativeWakeBridge(currentSessionId).catch(()=>{});
                await sleep(250);
            }else if(currentKind==='page-bridge'){
                try{emitWakeControl({action:'stop',epoch:Number(current.epoch)||0});}catch(_){}
            }
            resetWakeHealth();
        }
        S.voice.err='';
        const attempts=[];
        if(shouldUseFreePageWake(reason)&&!isBackgroundVoiceContext())attempts.push('page');
        if(shouldUseNativeDesktopWake(reason))attempts.push('native');
        if(shouldUseDeepgramWake(reason)&&isForegroundVoiceContext())attempts.push('deepgram');
        for(const engine of attempts){
            if(engine==='page'&&!isWakeEngineCoolingDown('page')){
                if(await startPageWake(reason))return true;
            }
            if(engine==='native'&&!isWakeEngineCoolingDown('native')){
                if(await startNativeWake(reason))return true;
            }
            if(engine==='deepgram'){
                if(await startDgWake(reason))return true;
            }
        }
        if(!attempts.length&&shouldForceNativeWake()&&!hasPersistentDesktopShell()){
            S.voice.err='';
            if(!S.voice.speaking)S.voice.mode='idle';
            render();
            scheduleWake(360);
            return false;
        }
        if(!S.voice.err)S.voice.err='Google STT wake-word motoru başlatılamadı.';
        render();
        return false;
    }finally{
        S.voice.wakeStarting=false;
    }
}
async function onWake(t,rawOpts={}){
    const opts=rawOpts&&typeof rawOpts==='object'?rawOpts:{};
    const inlineCommand=cleanupSpaces(String(opts.inlineCommand||extractWakeCommand(t)||''));
    const wakeSessionKey=normalizeVoiceSubmitSessionKey(opts.sessionKey||`wake:${Date.now()}`);
    log(`Wake-word algılandı: ${t}`);
    if(S.alert.active){
        await dismissActiveAlert('Aktif alarm susturuldu.');
        if(S.voice.speaking){
            S.voice.reply=null;
            cancelSpeech();
        }
        await prepareWakeForCommand('idle');
        toast('Alarm susturuldu.','ok');
        if(S.settings.voiceEnabled)await startWake('alert_dismissed');
        return;
    }
    const interruptingSpeech=!!S.voice.speaking;
    const backgroundWake=shouldUseNativeBackgroundVoice();
    const cmdReason=interruptingSpeech?'wake_interrupt':'wake_word';
    if(interruptingSpeech){
        S.voice.reply=null;
        cancelSpeech('HADES yeni komuta odaklandı.');
    }
    await prepareWakeForCommand('idle');
    if(inlineCommand){
        log(`Wake ile birlikte komut alındı: ${inlineCommand}`);
        toast(`Komut alındı: ${inlineCommand}`,'ok');
        await processRecognizedVoiceText(inlineCommand,'wake_inline',wakeSessionKey);
        return;
    }
    if(backgroundWake){
        toast('Dinliyorum babacığım.','ok');
        log('Arka planda wake-word sonrası Deepgram komut dinleme açılıyor.');
        speak('Dinliyorum babacığım.',null,{interruptible:false});
        if(S.settings.voiceEnabled)void startCmd(cmdReason);
        return;
    }
    if(interruptingSpeech){
        toast('Dinliyorum.','ok');
        if(S.settings.voiceEnabled)void startCmd(cmdReason,{waitForSpeechEnd:false});
        return;
    }
    const ackText='Efendim babacığım.';
    const ackDelay=wakeAckLeadMs(ackText);
    const startWakeCommand=()=>{if(S.settings.voiceEnabled&&!S.voice.cmd&&!S.voice.reply)void startCmd(cmdReason,{waitForSpeechEnd:false,ignoreAckMs:260});};
    toast('Efendim babacığım.','ok');
    speak(ackText,null,{interruptible:false});
    if(S.settings.voiceEnabled){
        if(ackDelay>0)setTimeout(startWakeCommand,ackDelay);
        else startWakeCommand();
    }
}
const compose=(f='')=>[...S.voice.segments,S.voice.interim,f].map(x=>String(x||'').trim()).filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
function mergeSegment(text=''){const next=speechText(text);if(!next)return;const prev=S.voice.segments[S.voice.segments.length-1]||'';if(prev&&norm(prev)===norm(next))return;if(prev&&norm(next).startsWith(norm(prev))){S.voice.segments[S.voice.segments.length-1]=next;return;}S.voice.segments.push(next);}
function normalizeCmdOptions(raw={}){const timeoutMs=Math.max(1800,Number(raw.timeoutMs)||COMMAND_TIMEOUT),hardTimeoutMs=Math.max(0,Number(raw.hardTimeoutMs)||0),activityMinChars=Math.max(0,Number(raw.activityMinChars)||0);return{timeoutMs,hardTimeoutMs,activityMinChars,silentNoSpeech:!!raw.silentNoSpeech,mode:raw.mode==='followup'?'followup':'command',waitForSpeechEnd:raw.waitForSpeechEnd!==false,ignoreAckMs:Math.max(0,Number(raw.ignoreAckMs)||0)};}
function isMeaningfulCmdActivity(text='',opts={}){const cleaned=speechText(String(text||'').trim()),minChars=Math.max(0,Number(opts?.activityMinChars)||0);if(!cleaned)return false;return cleaned.replace(/\s+/g,'').length>=minChars;}
async function transitionFollowupToWake(reason='followup_idle'){try{await stopCmd(true);}catch(_){}if(!S.settings.voiceEnabled)return;stopSchedule();clearWakeAck();S.voice.err='';S.voice.mode='idle';render();handoffWake(reason);}
function cmdTimeoutFire(){const t=compose();if(t){void finalizeVoice(t,'silence_timeout');return;}const opts=S.voice.cmdOptions||normalizeCmdOptions();if(opts.silentNoSpeech){void transitionFollowupToWake('followup_idle');return;}log('Ses komutu duyulamadı, wake-word moduna dönülüyor.');toast('Komut duyamadım.','warn');void stopCmd(true).then(()=>{if(S.settings.voiceEnabled)handoffWake('no_speech');});}
function resetCmd(){clearCmd();const opts=S.voice.cmdOptions||normalizeCmdOptions();_cmdTimeoutAt=Date.now()+opts.timeoutMs;S.voice.timeout=setTimeout(cmdTimeoutFire,opts.timeoutMs);}
async function startCmd(reason='manual',rawOpts={}){if(!S.settings.voiceEnabled||S.voice.cmd||S.voice.reply||(S.voice.speaking&&!reason.startsWith('wake_')))return;if(S.voice.recognizer||S.voice.dgWake)await prepareWakeForCommand('idle');if(!(await voiceReady()))return;try{const opts=normalizeCmdOptions(rawOpts),stream=await prep(),epoch=++S.voice.cEpoch,socket=new WebSocket(`${DG}?encoding=linear16&sample_rate=16000&language=tr&model=nova-2&endpointing=500&utterance_end_ms=1200&interim_results=true&smart_format=true`,['token',S.voice.key]),startedAt=Date.now();S.voice.segments=[];S.voice.interim='';S.voice.finalizing=false;S.voice.cmdOptions=opts;if(!S.voice.speaking||opts.waitForSpeechEnd===false)S.voice.mode=opts.mode;S.voice.cmd=socket;render();const open=()=>epoch===S.voice.cEpoch&&S.voice.cmd===socket&&S.settings.voiceEnabled;socket.onopen=()=>{if(!open()){try{socket.close();}catch(_){}return;}const beginAudio=()=>{if(!open())return;log(opts.mode==='followup'?'Takip dinleme aktif.':`Komut dinleme aktif (${reason}).`);S.voice.mode=opts.mode;render();audio(stream,socket,open,true);resetCmd();if(opts.hardTimeoutMs>0){S.voice.hardTimeout=setTimeout(()=>{if(!open())return;if(S.voice.segments.length||isMeaningfulCmdActivity(S.voice.interim,opts))return;log('Takip dinleme sessiz kaldı, wake moduna dönülüyor.');void transitionFollowupToWake('followup_idle');},opts.hardTimeoutMs);}};if(S.voice.speaking&&opts.waitForSpeechEnd!==false){const ttsEp=S.voice.ttsEpoch;const waitTts=()=>{if(!open())return;if(!S.voice.speaking||ttsEp!==S.voice.ttsEpoch){beginAudio();return;}setTimeout(waitTts,60);};waitTts();}else{beginAudio();}};socket.onmessage=(m)=>{if(!open())return;let d;try{d=JSON.parse(m.data);}catch(_){return;}const t=speechText(String(d.channel?.alternatives?.[0]?.transcript||'').trim()),stripped=stripAssistantAckPrefix(t),ackOnly=!!t&&opts.ignoreAckMs>0&&Date.now()-startedAt<=opts.ignoreAckMs&&!stripped&&!S.voice.segments.length&&!S.voice.interim;if(ackOnly){if(d.is_final)S.voice.interim='';return;}if(t){const meaningfulActivity=isMeaningfulCmdActivity(stripped||t,opts);if(d.is_final){mergeSegment(t);S.voice.interim='';}else S.voice.interim=t;if(!opts.silentNoSpeech||meaningfulActivity||S.voice.segments.length)resetCmd();if(meaningfulActivity&&S.voice.hardTimeout){clearTimeout(S.voice.hardTimeout);S.voice.hardTimeout=0;}}if(d.speech_final){void finalizeVoice(compose(t),'speech_final');}};socket.onerror=()=>{if(epoch!==S.voice.cEpoch)return;S.voice.err='Komut dinleme bağlantısı koptu.';render();log('Komut dinleme bağlantısı koptu.');void stopCmd(true).then(()=>{if(S.settings.voiceEnabled)void startWake('command_error');});};socket.onclose=()=>{if(epoch!==S.voice.cEpoch)return;S.voice.cmd=null;};}catch(e){S.voice.err=e.message||'Komut dinleme başlatılamadı.';render();log(S.voice.err);if(S.settings.voiceEnabled)scheduleWake();}}
async function processRecognizedVoiceText(raw,reason='final',sessionKey='direct'){const text=collapseRepeat(stripWake(stripAssistantAckPrefix(speechText(String(raw||'').replace(/\s+/g,' ').trim())))),submitSig=sig(norm(text));if(!text){log('Boş ses metni geldi, wake-word moduna dönülüyor.');if(S.settings.voiceEnabled)handoffWake('empty_transcript');return false;}if(shouldSuppressVoiceSubmit(submitSig,sessionKey)){log('Aynı ses oturumundan yinelenen metin atlandı.');if(S.settings.voiceEnabled)handoffWake('duplicate_transcript');return false;}rememberVoiceSubmit(submitSig,sessionKey);if(await runDirectLocalIntent(text,'voice')){toast(`Yerel komut işlendi: ${text}`,'ok');return true;}S.voice.reply={count:speakableAssistant().length,started:Date.now(),sig:'',stable:0,pendingSince:0};S.voice.mode='reply';render();await sendChat(text);log(`Ses metni sohbete gönderildi (${reason}): ${text}`);toast(`HADES'e gitti: ${text}`,'ok');if(shouldUseNativeBackgroundVoice())void startBackendReplyWatch();return true;}
async function finalizeVoice(raw,reason='final'){if(S.voice.finalizing)return;S.voice.finalizing=true;const sessionKey=`cmd:${S.voice.cEpoch}`;try{await stopCmd(true);await processRecognizedVoiceText(raw,reason,sessionKey);}catch(e){S.voice.reply=null;S.voice.err=e.message||'Ses komutu gönderilemedi.';render();log(S.voice.err);if(S.settings.voiceEnabled)await startWake('send_failed');}finally{S.voice.finalizing=false;}}
async function bootVoice(){
    try{
        initVoices();
        await loadVoiceCfg();
        if(S.settings.voiceEnabled){
            log('Ses altyapısı hazırlanıyor...');
            if(shouldForceNativeWake()&&!hasPersistentDesktopShell()){
                await waitForDesktopShellContext();
            }
            if(await ensureVoiceOwner('bootstrap')){
                const started=await startWake('bootstrap');
                if(!started&&S.settings.voiceEnabled){
                    log('Wake bootstrap ilk denemede hazır olmadı, yeniden denenecek.');
                    scheduleWake(480);
                }
            }else{
                log('Ses yetkisi görünür pencereyi bekliyor.');
                scheduleWake(600);
            }
        }
    }catch(e){
        S.voice.err=e.message||'Ses hazırlanamadı.';
        render();
        log(S.voice.err);
    }
}
function handleVoiceContextChange(){if(!S.settings.voiceEnabled)return;syncVoiceContextReady();if(!ownerVisible()){void releaseVoiceOwner();if(hasLiveWakeSession()||S.voice.cmd||S.voice.reply||S.voice.speaking){void relinquishVoice();}else{stopSchedule();S.voice.mode='idle';render();}return;}if(shouldForceNativeWake()&&activeWakeKind()==='page-bridge'&&!S.voice.wakeStarting&&!S.voice.wakeStopping&&!S.voice.cmd&&!S.voice.reply&&!S.voice.speaking){void migrateWakeToNative('focus_native');return;}void claimVoiceOwner('focus');if(S.voice.replyWs&&S.voice.reply){void stopBackendReplyWatch();}if(isBackgroundVoiceContext()&&!hasPersistentDesktopShell()){if(activeWakeKind()==='deepgram-wake'){void stopDgWake();}return;}if(!isBackgroundVoiceContext()&&!hasLiveWakeSession()&&!S.voice.cmd&&!S.voice.reply&&!S.voice.speaking&&!_wakeAt){void startWake('focus');}}
async function boot(){ui();brand();observe();bindManualScheduleInterceptors();initBgWorker();onBgTick(()=>{guardAudioContext();const now=Date.now();if(shouldForceNativeWake()&&activeWakeKind()==='page-bridge'&&!S.voice.wakeStarting&&!S.voice.wakeStopping&&!S.voice.cmd&&!S.voice.reply&&!S.voice.speaking&&now-Number(S.voice.lastWakeMigrationAt||0)>=2000){S.voice.lastWakeMigrationAt=now;void migrateWakeToNative('native_upgrade');return;}void maybeRefreshWakeHealth();if(S.voice.an){try{const len=S.voice.an.frequencyBinCount,data=new Uint8Array(len);S.voice.an.getByteFrequencyData(data);let sum=0;for(let i=0;i<len;i++)sum+=data[i];const pct=Math.min(100,(sum/len/128)*100);if(pct>1||S.voice.meterValue>1)setMeters(`${pct}%`);}catch(_){}}if(!isBackgroundVoiceContext()&&S.voice.speaking&&S.voice.speakingAt&&'speechSynthesis' in window&&!window.speechSynthesis.speaking&&!window.speechSynthesis.pending&&Date.now()-S.voice.speakingAt>2000){cancelSpeech('Tarayıcı TTS sona erdi ama state kaldı, sıfırlandı.');}if(now-_lastDomTick>=DOM_MAINTENANCE_INTERVAL){_lastDomTick=now;runDomMaintenance();}if(_wakeAt&&now>=_wakeAt){_wakeAt=0;void startWake('restart');}if(_cmdTimeoutAt&&now>=_cmdTimeoutAt){_cmdTimeoutAt=0;cmdTimeoutFire();}if(S.settings.voiceEnabled&&!S.voice.cmd&&!S.voice.reply&&!S.voice.speaking&&!_wakeAt&&!S.voice.wakeStarting){const wakeLive=hasLiveWakeSession(now),allowWake=isForegroundVoiceContext()||shouldUseNativeDesktopWake('guard')||shouldForceNativeWake();if(!wakeLive&&allowWake&&now-Number(S.voice.lastWakeKickAt||0)>=1500){S.voice.lastWakeKickAt=now;scheduleWake(140);}}});timer=setInterval(runDomMaintenance,DOM_MAINTENANCE_INTERVAL);await loadSettings();await refresh(false);syncVoiceContextReady();log('HADES hazır.');await bootVoice();await syncActiveAlert(true);}
window.addEventListener('focus',handleVoiceContextChange);
window.addEventListener('blur',handleVoiceContextChange);
document.addEventListener('visibilitychange',handleVoiceContextChange);
window.addEventListener('hades-window-context-change',handleVoiceContextChange);
window.addEventListener('beforeunload',()=>{if(timer){clearInterval(timer);timer=0;}if(domTimer){clearTimeout(domTimer);domTimer=0;}if(obs){obs.disconnect();obs=null;}clearAlertLoop();void releaseVoiceOwner();void stopVoice('beforeunload');});
boot().catch(e=>console.error('HADES Bridge bootstrap hatası:',e));
})();
