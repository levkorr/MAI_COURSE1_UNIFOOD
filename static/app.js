const $ = s => document.querySelector(s);
const escapeHTML = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let selectedMapId = null;
let schematicMap, mapMarkers, visibleMapPlaces = [];
const spriteUrl = $('#search use').getAttribute('href').split('#')[0];
const icon = (name, size = 20) => `<svg class="kit-icon kit-icon--${size}" aria-hidden="true" focusable="false"><use href="${spriteUrl}#${name}"></use></svg>`;
const statusStyles = {
 neutral: '',
 green: 'kit-feedback--success',
 amber: 'kit-feedback--warning',
 red: 'kit-feedback--failure',
};
const badge = place => `<span class="kit-badge kit-feedback type-small ${statusStyles[place.tone] || ''}">${escapeHTML(place.status)}</span>`;
function showStatus(selector, message, tone = 'neutral') {
 const status = $(selector);
 for (const style of Object.values(statusStyles).filter(Boolean)) {
  status.classList.toggle(style, style === statusStyles[tone]);
 }
 status.textContent = message;
}
const mobileLayout = matchMedia('(max-width: 730px)');
const workspace = $('#workspace');
const mapPanel = $('#place-map');

function syncWorkspaceOrder() {
 const edge = mobileLayout.matches ? workspace.firstElementChild : workspace.lastElementChild;
 if (edge === mapPanel) return;

 const active = document.activeElement;
 const restoreFocus = mapPanel.contains(active);
 if (mobileLayout.matches) workspace.prepend(mapPanel);
 else workspace.append(mapPanel);
 if (restoreFocus) active.focus({preventScroll: true});
}

syncWorkspaceOrder();
mobileLayout.addEventListener('change', syncWorkspaceOrder);

const universities=JSON.parse($('#university-data').textContent);
let university='mai', mapResizeObserver;
let ORIGIN={lat:universities[university].campus[0],lon:universities[university].campus[1]};
let viewMode='now', myPlan=null, loadedTime='now', loadedDate=null, canPlan=false, loadVersion=0;
const pastTimeMessage = 'Это время уже прошло. Записаться нельзя.';
const planned = () => viewMode==='planned';
const countLabel = p => planned()?`${p.planned_count} чел.`:p.report_count?`≈${p.people} чел.`:'Нет оценок';
const actionLabel = p => planned()?(myPlan?.place_id===p.id && myPlan.slot===loadedTime?'Отменить план':canPlan?'Пойду сюда':'Время прошло'):'Я здесь';
const actionDisabled = p => planned() && !canPlan && !(myPlan?.place_id===p.id && myPlan.slot===loadedTime)?'disabled':'';
function choosePlace(id){if(planned())updatePlan(id);else openCheckIn(id);}
async function updatePlan(id){
 if($('#time').value!==loadedTime || $('#search').disabled){showStatus('#plan-status','Дождитесь загрузки выбранного времени.','amber');return;}
 const cancel=myPlan?.place_id===id && myPlan.slot===loadedTime;
 if(!cancel && !canPlan){showStatus('#plan-status',pastTimeMessage,'amber');return;}
 document.querySelectorAll('.check-in-trigger, #detail-check-in, .kit-place-card__plan').forEach(b=>b.disabled=true);
 try{
  const response=await fetch('/api/plans?university='+university+'&date='+loadedDate,{method:cancel?'DELETE':'POST',headers:{'Content-Type':'application/json'},...(cancel?{}:{body:JSON.stringify({place_id:id,time:loadedTime})})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Не удалось сохранить план');
  myPlan=data.my_plan;
  $('#detail').close();
  await load();
  showStatus('#plan-status',cancel?'План отменён.':'План сохранён. Вы учтены среди тех, кто собирается прийти.','green');
 }catch(error){showStatus('#plan-status',error.message,'red');}
 finally{if(places.length)render();}
}
function mapPoint(p){
 const north=(p.lat-ORIGIN.lat)*111195;
 const east=(p.lon-ORIGIN.lon)*111195*Math.cos(ORIGIN.lat*Math.PI/180);
 return {point:[500+north/2.2,500+east/2.2],inside:Math.hypot(north,east)<=1000};
}
function reportSummary(p){
 if(planned())return myPlan?.place_id===p.id?`<span class="visitor-report type-small">Ваш план на сегодня: ${escapeHTML(myPlan.slot)}</span>`:'';
 if(!p.current_report || p.current_report.expires_at*1000 <= Date.now()) return '';
 const minutes=Math.max(0,Math.floor((Date.now()-p.current_report.observed_at*1000)/60000));
 return `<span class="visitor-report type-small">● Последняя оценка: ${escapeHTML(p.current_report.people_range.replace('-', '–'))} человек · ${minutes?minutes+' мин назад':'только что'}</span>`;
}
const checkInDialog = $('#check-in');
const checkInForm = $('#check-in-form');
const checkInSubmit = $('#check-in-submit');
let checkInSession;

function openCheckIn(id) {
 if (planned()) return updatePlan(id);
 const place = places.find(candidate => candidate.id === id);
 if (!place) return;

 const opener = document.activeElement;
 checkInSession = {id, university, opener, fromMap: mapPanel.contains(opener), pending: false, saved: false};
 checkInForm.reset();
 checkInSubmit.textContent = 'Отправить оценку';
 checkInSubmit.disabled = true;
 checkInSubmit.removeAttribute('aria-busy');
 showStatus('#check-in-status', '');
 $('#check-in-name').textContent = place.name;
 checkInDialog.showModal();
}

async function submitCheckIn(event) {
 event.preventDefault();
 const session = checkInSession;
 const range = new FormData(checkInForm).get('people_range');
 if (!session || !range || session.pending || session.saved) return;

 session.pending = true;
 checkInSubmit.disabled = true;
 checkInSubmit.setAttribute('aria-busy', 'true');
 showStatus('#check-in-status', 'Сохраняем…');
 try {
  const response = await fetch('/api/check-ins?university=' + session.university, {
   method: 'POST',
   headers: {'Content-Type': 'application/json'},
   body: JSON.stringify({place_id: session.id, people_range: range}),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Не удалось сохранить ответ');
  session.saved = true;
  if (university === session.university && !planned()) {
   const place = places.find(candidate => candidate.id === session.id);
   if (place) {
    Object.assign(place, data.place);
    render();
   }
  }
  if (checkInSession === session) {
   showStatus('#check-in-status', 'Спасибо! Сообщение сохранено и будет видно 30 минут.', 'green');
   checkInSubmit.textContent = 'Ответ сохранён';
  }
 } catch (error) {
  if (checkInSession === session) {
   showStatus('#check-in-status', error.message, 'red');
   checkInSubmit.disabled = false;
  }
 } finally {
  session.pending = false;
  if (checkInSession === session) checkInSubmit.removeAttribute('aria-busy');
 }
}

checkInDialog.querySelector('.check-in-close').onclick = () => checkInDialog.close();
checkInDialog.onclick = event => {
 if (event.target === checkInDialog) checkInDialog.close();
};
checkInForm.onchange = () => {
 if (!checkInSession?.pending && !checkInSession?.saved) checkInSubmit.disabled = false;
};
checkInForm.onsubmit = submitCheckIn;
checkInDialog.addEventListener('close', () => {
 if (checkInDialog.open) return;
 const session = checkInSession;
 checkInSession = null;
 if (!session || session.opener?.isConnected) return;

 const action = session.fromMap && $('#map-selection .check-in-trigger');
 const title = [...document.querySelectorAll('.place-title')].find(button => button.dataset.detail === session.id);
 (action || title || $('#search')).focus();
});

function initMap(){
 mapResizeObserver?.disconnect();if(schematicMap)schematicMap.remove();schematicMap=null;mapMarkers=null;
 $('#map').innerHTML = `<div class="schematic-head"><span>ОКРЕСТНОСТИ ${universities[university].name}</span><span class="radius-pill">↗ Радиус 1 км</span></div><div class="schematic-canvas" id="schematic-view" aria-label="Схема: используйте плюс и минус для масштаба, стрелки для перемещения"></div><div class="schematic-legend type-small"><span><i class="kit-feedback" aria-hidden="true"></i>Нет оценок</span><span><i class="kit-feedback kit-feedback--success" aria-hidden="true"></i>Свободно</span><span><i class="kit-feedback kit-feedback--warning" aria-hidden="true"></i>Умеренно</span><span><i class="kit-feedback kit-feedback--failure" aria-hidden="true"></i>Загружено</span><small>По оценкам посетителей</small></div><div id="map-selection" class="map-selection kit-card kit-surface-card"></div><div class="schematic-credit type-small"><span>© <a class="kit-link" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a></span></div>`;
 if(!window.L){$('#schematic-view').textContent='Не удалось загрузить карту. Обновите страницу.';return;}
 const bounds=L.latLngBounds([[0,0],[1000,1000]]);
 schematicMap=L.map('schematic-view',{crs:L.CRS.Simple,minZoom:-5,maxBounds:bounds,maxBoundsViscosity:1,maxZoom:2,zoomSnap:0.1,zoomDelta:0.25,scrollWheelZoom:true,wheelDebounceTime:40,wheelPxPerZoomLevel:180,zoomAnimation:false,markerZoomAnimation:false,fadeAnimation:false,inertia:false,attributionControl:false});
 L.imageOverlay('/static/'+universities[university].map+'?v=universities',bounds,{interactive:false}).addTo(schematicMap);
 const resetView=()=>{schematicMap.invalidateSize();schematicMap.setMinZoom(-5);const zoom=schematicMap.getBoundsZoom(bounds);schematicMap.setMinZoom(zoom);schematicMap.fitBounds(bounds,{animate:false});};
 const mapView = $('#schematic-view');
 let needsFit = !mapView.clientWidth;
 if (!needsFit) resetView();
 else schematicMap.setView(bounds.getCenter(), -2);
 L.marker([500,500],{icon:L.divIcon({className:'campus-map-icon',html:`<span>✦</span><b>${universities[university].origin_label}</b>`,iconSize:[39,39],iconAnchor:[19.5,19.5]}),zIndexOffset:1000,title:universities[university].origin_label}).addTo(schematicMap);
 mapMarkers=L.layerGroup().addTo(schematicMap);
 const reset=L.control({position:'topright'});
 reset.onAdd=()=>{const button=L.DomUtil.create('button','map-reset kit-action kit-action--secondary kit-surface-control');button.type='button';button.textContent='Весь район';button.title='Показать весь радиус 1 км';L.DomEvent.disableClickPropagation(button);button.onclick=resetView;return button;};reset.addTo(schematicMap);
 schematicMap.zoomControl.setPosition('topright');
 schematicMap.zoomControl._zoomInButton.setAttribute('aria-label','Приблизить схему');
 schematicMap.zoomControl._zoomOutButton.setAttribute('aria-label','Отдалить схему');
 const resizeMap = () => {
  if (!mapView.clientWidth || !mapView.clientHeight) return;
  if (needsFit) {
   needsFit = false;
   resetView();
   return;
  }
  schematicMap.invalidateSize({ pan: false });
  schematicMap.setMinZoom(-5);
  schematicMap.setMinZoom(schematicMap.getBoundsZoom(bounds));
 };
 mapResizeObserver = new ResizeObserver(resizeMap);
 mapResizeObserver.observe(mapView);
}
function locate(id){
 selectedMapId=id;
 const p=places.find(p=>p.id===id);
 renderMap(visibleMapPlaces);
 if(p&&schematicMap&&$('#schematic-view').clientWidth){
  schematicMap.setView(mapPoint(p).point,Math.max(schematicMap.getZoom(),0.5),{animate:false});
 }
 document.querySelectorAll('.card').forEach(card=>card.classList.toggle('map-selected',card.querySelector('[data-locate]')?.dataset.locate===id));
}

function renderMap(list){
 visibleMapPlaces=list;
 const inRange=list.filter(p=>mapPoint(p).inside);
 const p=inRange.find(p=>p.id===selectedMapId)||inRange[0];
 selectedMapId=p?.id||null;
 if(mapMarkers){mapMarkers.clearLayers();inRange.forEach(place=>{
  const icon=L.divIcon({className:`load-map-icon kit-feedback ${statusStyles[place.tone] || ""} ${place.id===selectedMapId?'is-selected':''}`,html:`<span>${place.icon}</span><b>${countLabel(place)}</b>`,iconSize:[76,44],iconAnchor:[38,22]});
  const marker=L.marker(mapPoint(place).point,{icon,title:`${place.name}: ${place.status} · ${countLabel(place)}`,zIndexOffset:place.id===selectedMapId?500:0}).addTo(mapMarkers);
  marker.bindTooltip(`${escapeHTML(place.name)} · ${countLabel(place)}`);
  marker.on('click',()=>{selectedMapId=place.id;renderMap(visibleMapPlaces);const popup=L.popup({className:'check-in-popup',closeButton:true}).setLatLng(mapPoint(place).point).setContent(`<strong>${escapeHTML(place.name)}</strong><p>${planned()?`План на сегодня, около ${loadedTime}`:'Сколько людей здесь сейчас?'}</p><button type="button" class="popup-check-in check-in-trigger kit-action kit-surface-control" ${actionDisabled(place)}>${actionLabel(place)}</button>`).openOn(schematicMap);popup.getElement().querySelector('.popup-check-in').onclick=()=>choosePlace(place.id);document.querySelectorAll('.card').forEach(card=>card.classList.toggle('map-selected',card.querySelector('[data-locate]')?.dataset.locate===place.id));});
  marker.on('dblclick',()=>details(place.id));
 });}
 if(!p){$('#map-selection').textContent='Нет заведений для выбранного фильтра';return;}
 $('#map-selection').innerHTML=`<div class="selection-icon">${p.icon}</div><div><button class="map-place-detail kit-action kit-action--secondary kit-surface-control">${escapeHTML(p.name)}</button><span>≈ ${p.walk} мин пешком · ${p.distance} м по прямой</span>${reportSummary(p)}</div><button class="check-in-trigger kit-action kit-surface-control" type="button" ${actionDisabled(p)}>${actionLabel(p)}</button>`;
 $('#map-selection .map-place-detail').onclick=()=>details(p.id);$('#map-selection .check-in-trigger').onclick=()=>openCheckIn(p.id);
}

let places = [], category = 'all';
let saved;
try { saved = new Set(JSON.parse(localStorage.getItem('mp-favorites') || '[]')); } catch { saved = new Set(); }
function setBreaks(){
 const periods=universities[university].breaks;
 $('#break').innerHTML=periods.map((p,i)=>`<option value="${i}">${p.start} – ${p.end} · ${p.duration} минут</option>`).join('');
 $('#break').value=university==='mai'?'1':'0';
 setTimes(true);
}
$('#university').onchange=()=>{
 university=$('#university').value;
 const config=universities[university];ORIGIN={lat:config.campus[0],lon:config.campus[1]};
 selectedMapId=null;places=[];myPlan=null;
 $('#university-heading').textContent='Рядом с '+config.name;
 setBreaks();initMap();load();
};
function setTimes(initial=false){
 const group=universities[university].breaks[Number($('#break').value)].slots;
 const preferred=initial?'now':group[0];
 $('#time').innerHTML='<option value="now">Сейчас</option>'+group.map(t=>`<option ${t===preferred?'selected':''}>${t}</option>`).join('');
 $('#time').value=preferred;
}

function save(id){saved.has(id)?saved.delete(id):saved.add(id);try{localStorage.setItem('mp-favorites',JSON.stringify([...saved]));}catch{}render();}
function details(id){
 const p=places.find(p=>p.id===id);if(!p)return;
 const description=planned()
  ? `сегодня около ${loadedTime} (±5 минут) сюда собираются ${p.planned_count} чел. Это планы пользователей, а не фактическое число посетителей.`
  : p.report_count?`Сейчас примерно ${p.people} чел. · оценок за 30 минут: ${p.report_count}`:'Пока нет свежих оценок посетителей. Число людей неизвестно.';
 $('#detail-content').innerHTML=`<div class="detail-icon">${p.icon}</div><h2 id="detail-title" class="detail-title type-h2">${escapeHTML(p.name)}</h2><p class="detail-text">${p.label} · ≈ ${p.walk} мин пешком от ${universities[university].name}</p>${badge(p)}<p class="detail-text">${description}</p><p class="detail-text">${escapeHTML(p.address === "Адрес не указан в OSM" ? "Адрес не указан" : p.address)}<br>${escapeHTML(p.hours)}</p><a class="source-link kit-link" href="https://yandex.ru/maps/?rtext=${ORIGIN.lat},${ORIGIN.lon}~${p.lat},${p.lon}&rtt=pd" target="_blank" rel="noopener noreferrer">Построить пеший маршрут ↗</a>${reportSummary(p)}<button class="check-in-primary kit-action kit-surface-control" id="detail-check-in" type="button" ${actionDisabled(p)}>${actionLabel(p)}</button>`;
 $('#detail').showModal();$('#detail-check-in').onclick=()=>{$('#detail').close();choosePlace(id);};locate(id);
}
const placeCardTemplate = $('#place-card-template');
function renderPlaceCard(place) {
 const card = placeCardTemplate.content.firstElementChild.cloneNode(true);
 const title = card.querySelector('[data-detail]');
 const favorite = card.querySelector('[data-save]');
 const locateButton = card.querySelector('[data-locate]');
 const plan = card.querySelector('[data-plan]');
 const status = card.querySelector('[data-place-status]');
 const isPlanned = planned();
 const savedPlan = isPlanned && myPlan?.place_id === place.id && myPlan.slot === loadedTime;

 title.textContent = place.name;
 title.dataset.detail = place.id;
 card.querySelector('[data-place-meta]').textContent = `${place.label} · ${place.walk} мин пешком`;
 favorite.dataset.save = place.id;
 favorite.setAttribute('aria-label', `Избранное: ${place.name}`);
 favorite.setAttribute('aria-pressed', String(saved.has(place.id)));
 locateButton.dataset.locate = place.id;
 locateButton.setAttribute('aria-label', `Показать ${place.name} на карте`);

 if (savedPlan) status.textContent = `План на сегодня · ${loadedTime}`;
 else if (isPlanned) status.textContent = place.status;
 else if (place.report_count) status.textContent = `${place.status} · ≈ ${place.people} чел.`;
 else status.textContent = 'Пока нет оценок';

 const tone = statusStyles[savedPlan ? 'green' : place.tone];
 if (tone) status.classList.add(tone);

 plan.dataset.plan = place.id;
 plan.hidden = !isPlanned;
 plan.disabled = !isPlanned || (!canPlan && !savedPlan);
 if (isPlanned) plan.textContent = actionLabel(place);
 plan.classList.toggle('kit-action--secondary', savedPlan);
 return card;
}

function render(){
 const sort=$('#sort').value;
 const list=places.filter(p=>category==='all'||(category==='favorites'?saved.has(p.id):p.category===category)).sort((a,b)=>Number(saved.has(b.id))-Number(saved.has(a.id))||(sort==='walk'?a.walk-b.walk:planned()?a.planned_count-b.planned_count:a.load-b.load));
 $('#count').textContent=list.length;$('#fav-count').textContent=saved.size;$('#empty').hidden=!!list.length;
 const cards = $('#cards');
 cards.replaceChildren(...list.map(renderPlaceCard));
 cards.tabIndex = list.length ? 0 : -1;
 renderMap(list);
 document.querySelectorAll('[data-locate]').forEach(button => button.onclick = () => {
  if (mobileLayout.matches) {
   mapPanel.focus({preventScroll: true});
   mapPanel.scrollIntoView({block: 'start'});
  }
  locate(button.dataset.locate);
 });
 document.querySelectorAll('[data-save]').forEach(button => button.onclick = () => {
  const id = button.dataset.save;
  save(id);
  const replacement = [...document.querySelectorAll('[data-save]')].find(candidate => candidate.dataset.save === id);
  (replacement || $('#favorites')).focus();
 });
 document.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>details(b.dataset.detail));
 document.querySelectorAll('[data-plan]').forEach(b=>b.onclick=()=>updatePlan(b.dataset.plan));
 $('#empty').textContent=category==='favorites'?'Пока нет избранных заведений рядом с этим вузом. Добавь место кнопкой «Избранное».':'Для выбранного фильтра заведений нет.';
 $('.schematic-legend').innerHTML=planned()?'<span>Число людей, планирующих прийти ±5 минут</span>':'<span><i class="kit-feedback" aria-hidden="true"></i>Нет оценок</span><span><i class="kit-feedback kit-feedback--success" aria-hidden="true"></i>Свободно</span><span><i class="kit-feedback kit-feedback--warning" aria-hidden="true"></i>Умеренно</span><span><i class="kit-feedback kit-feedback--failure" aria-hidden="true"></i>Загружено</span><small>По оценкам посетителей</small>';
}
async function load(){
 const version=++loadVersion, slot=$('#time').value, b=$('#search');
 b.disabled=true;b.setAttribute('aria-busy','true');$('#search-label').textContent='Ищем места…';$('#plan-status').textContent='';
 $('#results-error').hidden=true;$('#results-error').textContent='';
 if($('#detail').open)$('#detail').close();
 if($('#check-in').open)$('#check-in').close();
 if(schematicMap)schematicMap.closePopup();
 document.querySelectorAll('.check-in-trigger').forEach(button=>button.disabled=true);
 try{
  const response=await fetch('/api/places?time='+encodeURIComponent(slot)+'&university='+university);const data=await response.json();
  if(version!==loadVersion)return;
  if(!response.ok)throw Error(data.error||'Не удалось загрузить места');
  places=data.places;viewMode=data.mode;myPlan=data.my_plan;loadedTime=data.time;loadedDate=data.visit_date;canPlan=data.can_plan;
  $('#plan-time-note').textContent=planned()&&!canPlan?pastTimeMessage:'';
  $('#result-label').textContent=planned()?`Планы на сегодня · ${data.time} ±${data.window_minutes} мин`:'Загруженность сейчас';
  $('#sort').options[0].textContent=planned()?'Сначала меньше планов':'Сначала свободные';
  render();
  const rated=places.filter(p=>p.report_count>0);
  $('#tip').textContent=planned()?'Учитываются планы на сегодня в пределах ±5 минут от выбранного времени. Новый план заменяет предыдущий.':rated.length?`Есть свежие оценки для ${rated.length} мест. Примерное число людей — по сообщениям за последние 30 минут.`:'Пока нет свежих оценок. Нажми «Я здесь», чтобы сообщить, сколько людей сейчас в заведении.';
 }catch(error){if(version!==loadVersion)return;places=[];render();$('#empty').hidden=true;$('#plan-time-note').textContent='';$('#results-error').hidden=false;$('#results-error').textContent=error.message||'Не удалось загрузить места. Повторите поиск.';}
 finally{if(version===loadVersion){b.disabled=false;b.removeAttribute('aria-busy');$('#search-label').textContent='Найти место';}}
}
$('#break').onchange=()=>{setTimes();load();};$('#time').onchange=load;$('#search').onclick=load;$('#sort').onchange=render;document.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{category=b.dataset.category;document.querySelectorAll('[data-category]').forEach(c=>{c.setAttribute('aria-pressed',b===c);});render();});$('#close-dialog').onclick=()=>$('#detail').close();$('#detail').onclick=e=>{if(e.target===$('#detail'))$('#detail').close();};initMap();setBreaks();load();

setInterval(()=>{if(!document.hidden && !document.querySelector("dialog[open]"))load();},60000);
