const $ = s => document.querySelector(s);
const escapeHTML = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let selectedMapId = null;
let schematicMap, mapMarkers, resizeMap, visibleMapPlaces = [];
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
const clusterPreview = new URLSearchParams(location.search).get('map') === 'groups';
if (clusterPreview) $('#workspace').classList.add('workspace-map-preview');
const viewButtons = document.querySelectorAll('[data-view]');

function setWorkspaceView(view) {
 const workspace = $('#workspace');
 if (view !== workspace.dataset.view && view === 'list') schematicMap?.closePopup();
 workspace.dataset.view = view;
 viewButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
 if (view === 'map') resizeMap?.();
}

const universities=JSON.parse($('#university-data').textContent);
let university='mai', mapResizeObserver;
let ORIGIN={lat:universities[university].campus[0],lon:universities[university].campus[1]};
let viewMode='now', myPlan=null, loadedTime='now', loadedDate=null, canPlan=false, loadVersion=0;
const dayLabel = () => $('#visit-date').selectedOptions[0].textContent.toLowerCase();
const planned = () => viewMode==='planned';
const countLabel = p => planned()?`${p.planned_count} чел.`:p.report_count?`≈${p.people} чел.`:'Нет оценок';
const actionLabel = p => planned()?(myPlan?.place_id===p.id && myPlan.slot===loadedTime?'Отменить план':canPlan?'Пойду сюда':'Время прошло'):'Я здесь';
const actionDisabled = p => planned() && !canPlan && !(myPlan?.place_id===p.id && myPlan.slot===loadedTime)?'disabled':'';
function choosePlace(id){if(planned())updatePlan(id);else openCheckIn(id);}
async function updatePlan(id){
 if($('#time').value!==loadedTime || $('#visit-date').value!==loadedDate || $('#search').disabled){showStatus('#plan-status','Дождитесь загрузки выбранного времени.','amber');return;}
 const cancel=myPlan?.place_id===id && myPlan.slot===loadedTime;
 if(!cancel && !canPlan){showStatus('#plan-status','Это время уже прошло. Выберите «Завтра» или более позднее время.','amber');return;}
 document.querySelectorAll('.check-in-trigger, #detail-check-in').forEach(b=>b.disabled=true);
 try{
  const response=await fetch('/api/plans?university='+university+'&date='+loadedDate,{method:cancel?'DELETE':'POST',headers:{'Content-Type':'application/json'},...(cancel?{}:{body:JSON.stringify({place_id:id,time:loadedTime})})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Не удалось сохранить план');
  myPlan=data.my_plan;
  $('#detail').close();
  await load();
  showStatus('#plan-status',cancel?'План отменён.':'План сохранён. Вы учтены среди тех, кто собирается прийти.','green');
 }catch(error){showStatus('#plan-status',error.message,'red');}
 finally{document.querySelectorAll('.check-in-trigger, #detail-check-in').forEach(b=>b.disabled=false);if(places.length)render();}
}
function mapPoint(p){
 const north=(p.lat-ORIGIN.lat)*111195;
 const east=(p.lon-ORIGIN.lon)*111195*Math.cos(ORIGIN.lat*Math.PI/180);
 return {point:[500+north/2.2,500+east/2.2],inside:Math.hypot(north,east)<=1000};
}
function reportSummary(p){
 if(planned())return myPlan?.place_id===p.id?`<span class="visitor-report type-small">Ваш план на ${dayLabel()}: ${escapeHTML(myPlan.slot)}</span>`:'';
 if(!p.current_report || p.current_report.expires_at*1000 <= Date.now()) return '';
 const minutes=Math.max(0,Math.floor((Date.now()-p.current_report.observed_at*1000)/60000));
 return `<span class="visitor-report type-small">● Последняя оценка: ${escapeHTML(p.current_report.people_range.replace('-', '–'))} человек · ${minutes?minutes+' мин назад':'только что'}</span>`;
}
let checkInPlaceId=null;
function openCheckIn(id){
 if(planned())return updatePlan(id);
 const p=places.find(p=>p.id===id);if(!p)return;
 checkInPlaceId=id;
 $('#check-in-form').reset();$('#check-in-submit').textContent='Поделиться';$('#check-in-status').textContent='';$('#check-in-submit').disabled=false;
 $('#check-in-name').textContent=p.name;
 $('#check-in').showModal();
}
async function submitCheckIn(event){
 event.preventDefault();
 const range=new FormData(event.currentTarget).get('people_range');
 const id=checkInPlaceId;
 $('#check-in-submit').disabled=true;$('#check-in-submit').setAttribute('aria-busy','true');showStatus('#check-in-status','Сохраняем…');
 try{
  const response=await fetch('/api/check-ins?university='+university,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({place_id:id,people_range:range})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Не удалось сохранить ответ');
  const p=places.find(p=>p.id===id);if(p)Object.assign(p,data.place);
  render();
  showStatus('#check-in-status','Спасибо! Сообщение сохранено и будет видно 30 минут.','green');
  $('#check-in-submit').textContent='Ответ сохранён';
 }catch(error){showStatus('#check-in-status',error.message,'red');$('#check-in-submit').disabled=false;}
 finally{$('#check-in-submit').removeAttribute('aria-busy');}
}
function initMap(){
 mapResizeObserver?.disconnect();if(schematicMap)schematicMap.remove();schematicMap=null;mapMarkers=null;
 resizeMap = null;
 $('#check-in')?.remove();
 const dialog=document.createElement('dialog');dialog.id='check-in';
 dialog.className='kit-surface-float';
 dialog.setAttribute('aria-labelledby','check-in-title');
 dialog.innerHTML=`<button class="check-in-close dialog-close kit-action kit-surface-control kit-action--secondary" type="button" aria-label="Закрыть отметку">${icon("x",24)}</button><h2 id="check-in-title" class="type-h2">Я здесь</h2><p id="check-in-name"></p><form id="check-in-form"><fieldset><legend>Сколько людей сейчас в заведении?</legend><div class="people-options">${['0-5','5-10','10-15','15-20'].map(range=>`<label class="kit-choice"><input type="radio" name="people_range" value="${range}" required><span>${range.replace('-','–')}<small>человек</small></span></label>`).join('')}</div></fieldset><p class="check-in-note">Примерной оценки достаточно. Оценка учитывается в загруженности 30 минут. Процент — средняя оценка числа людей относительно 20 посетителей.</p><button id="check-in-submit" class="check-in-primary kit-action kit-surface-control" type="submit">Поделиться</button><p id="check-in-status" role="status" aria-live="polite"></p></form>`;
 document.body.append(dialog);
 $('#check-in-status').classList.add('kit-feedback');
 dialog.querySelector('.check-in-close').onclick=()=>dialog.close();
 dialog.onclick=e=>{if(e.target===dialog)dialog.close();};
 $('#check-in-form').onsubmit=submitCheckIn;

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
 if (clusterPreview) schematicMap.on('zoomend', () => renderMap(visibleMapPlaces));
 const reset=L.control({position:'topright'});
 reset.onAdd=()=>{const button=L.DomUtil.create('button','map-reset kit-action kit-action--secondary kit-surface-control');button.type='button';button.textContent='Весь район';button.title='Показать весь радиус 1 км';L.DomEvent.disableClickPropagation(button);button.onclick=resetView;return button;};reset.addTo(schematicMap);
 schematicMap.zoomControl.setPosition('topright');
 schematicMap.zoomControl._zoomInButton.setAttribute('aria-label','Приблизить схему');
 schematicMap.zoomControl._zoomOutButton.setAttribute('aria-label','Отдалить схему');
 resizeMap = () => {
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

function groupMapPlaces(places) {
 const groups = places.map(place => ({places: [place], point: L.latLng(mapPoint(place).point)}));
 // Work in screen pixels so the same footprint applies at every zoom.
 for (let index = 0; index < groups.length; index++) {
  const group = groups[index];
  const center = schematicMap.project(group.point);
  const overlap = groups.findIndex((candidate, candidateIndex) => {
   if (candidateIndex <= index) return false;
   const other = schematicMap.project(candidate.point);
   const width = (group.places.length === 1 ? 38 : 22) + (candidate.places.length === 1 ? 38 : 22);
   return Math.abs(other.x - center.x) < width + 8 && Math.abs(other.y - center.y) < 52;
  });
  if (overlap === -1) continue;

  const other = groups.splice(overlap, 1)[0];
  const count = group.places.length + other.places.length;
  group.point = L.latLng(
   (group.point.lat * group.places.length + other.point.lat * other.places.length) / count,
   (group.point.lng * group.places.length + other.point.lng * other.places.length) / count,
  );
  group.places.push(...other.places);
  // A new center can intersect a group that was already checked.
  index = -1;
 }
 return groups;
}

function addMapGroup(group) {
 const label = `Мест в группе: ${group.places.length}`;
 const selected = group.places.some(place => place.id === selectedMapId);
 const marker = L.marker(group.point, {
  title: label,
  zIndexOffset: 1200,
  icon: L.divIcon({
   className: `map-group ${selected ? 'map-group-selected' : ''}`,
   html: `<span aria-hidden="true">${group.places.length}</span>`,
   iconSize: [44, 44],
   iconAnchor: [22, 22],
  }),
 }).addTo(mapMarkers);
 marker.getElement().setAttribute('aria-label', label);
 marker.on('click', event => {
  const fromKeyboard = event.originalEvent?.type === 'keypress';
  if (schematicMap.getZoom() < schematicMap.getMaxZoom()) {
   schematicMap.setView(group.point, Math.min(schematicMap.getZoom() + 1, schematicMap.getMaxZoom()), {animate: false});
   if (fromKeyboard) $('#schematic-view').focus();
   return;
  }

  const content = document.createElement('div');
  content.className = 'map-group-list';
  const title = document.createElement('strong');
  title.textContent = label;
  content.append(title);
  for (const place of group.places) {
   const button = document.createElement('button');
   button.type = 'button';
   button.className = 'kit-action kit-action--secondary kit-surface-control';
   button.textContent = place.name;
   button.onclick = () => details(place.id);
   content.append(button);
  }
  L.popup().setLatLng(group.point).setContent(content).openOn(schematicMap);
  if (fromKeyboard) content.querySelector('button')?.focus();
 });
}

function renderMap(list){
 visibleMapPlaces=list;
 const inRange=list.filter(p=>mapPoint(p).inside);
 const p=inRange.find(p=>p.id===selectedMapId)||inRange[0];
 selectedMapId=p?.id||null;
 if(mapMarkers){mapMarkers.clearLayers();
  const groups = clusterPreview ? groupMapPlaces(inRange) : inRange.map(place => ({places: [place]}));
  groups.forEach(group=>{
  if (group.places.length > 1) { addMapGroup(group); return; }
  const [place] = group.places;
  const icon=L.divIcon({className:`load-map-icon kit-feedback ${statusStyles[place.tone] || ""} ${place.id===selectedMapId?'is-selected':''}`,html:`<span>${place.icon}</span><b>${countLabel(place)}</b>`,iconSize:[76,44],iconAnchor:[38,22]});
  const marker=L.marker(mapPoint(place).point,{icon,title:`${place.name}: ${place.status} · ${countLabel(place)}`,zIndexOffset:place.id===selectedMapId?500:0}).addTo(mapMarkers);
  marker.bindTooltip(`${escapeHTML(place.name)} · ${countLabel(place)}`);
  marker.on('click',()=>{selectedMapId=place.id;renderMap(visibleMapPlaces);const popup=L.popup({className:'check-in-popup',closeButton:true}).setLatLng(mapPoint(place).point).setContent(`<strong>${escapeHTML(place.name)}</strong><p>${planned()?`План на ${dayLabel()}, около ${loadedTime}`:'Сколько людей здесь сейчас?'}</p><button type="button" class="popup-check-in check-in-trigger kit-action kit-surface-control" ${actionDisabled(place)}>${actionLabel(place)}</button>`).openOn(schematicMap);popup.getElement().querySelector('.popup-check-in').onclick=()=>choosePlace(place.id);document.querySelectorAll('.card').forEach(card=>card.classList.toggle('map-selected',card.querySelector('[data-locate]')?.dataset.locate===place.id));});
  marker.on('dblclick',()=>details(place.id));
 });}
 if(!p){$('#map-selection').textContent='Нет заведений для выбранного фильтра';return;}
 $('#map-selection').innerHTML=`<div class="selection-icon">${p.icon}</div><div><button class="map-place-detail kit-action kit-action--secondary kit-surface-control">${escapeHTML(p.name)} ↗</button><span>≈ ${p.walk} мин пешком · ${p.distance} м по прямой</span>${reportSummary(p)}</div><button class="check-in-trigger kit-action kit-surface-control" type="button" ${actionDisabled(p)}>${actionLabel(p)}</button>`;
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
  ? `${dayLabel()} около ${loadedTime} (±5 минут) сюда собираются ${p.planned_count} чел. Это планы пользователей, а не фактическое число посетителей.`
  : p.report_count?`Сейчас примерно ${p.people} чел. · оценок за 30 минут: ${p.report_count}`:'Пока нет свежих оценок посетителей. Число людей неизвестно.';
 $('#detail-content').innerHTML=`<div class="detail-icon">${p.icon}</div><h2 id="detail-title" class="detail-title type-h2">${escapeHTML(p.name)}</h2><p class="detail-text">${p.label} · ≈ ${p.walk} мин пешком от ${universities[university].name}</p>${badge(p)}<p class="detail-text">${description}</p><p class="detail-text">${escapeHTML(p.address === "Адрес не указан в OSM" ? "Адрес не указан" : p.address)}<br>${escapeHTML(p.hours)}</p><a class="source-link kit-link" href="https://yandex.ru/maps/?rtext=${ORIGIN.lat},${ORIGIN.lon}~${p.lat},${p.lon}&rtt=pd" target="_blank" rel="noopener noreferrer">Построить пеший маршрут ↗</a>${reportSummary(p)}<button class="check-in-primary kit-action kit-surface-control" id="detail-check-in" type="button" ${actionDisabled(p)}>${actionLabel(p)}</button>`;
 $('#detail').showModal();$('#detail-check-in').onclick=()=>{$('#detail').close();choosePlace(id);};locate(id);
}
function render(){
 $('#plan-day').hidden=!planned();
 $('#plan-day-note').textContent=planned()&&!canPlan?'Это время уже прошло. Выберите «Завтра» или более позднее время.':'';
 const sort=$('#sort').value;
 const list=places.filter(p=>category==='all'||(category==='favorites'?saved.has(p.id):p.category===category)).sort((a,b)=>Number(saved.has(b.id))-Number(saved.has(a.id))||(sort==='walk'?a.walk-b.walk:planned()?a.planned_count-b.planned_count:a.load-b.load));
 $('#count').textContent=list.length;$('#fav-count').textContent=saved.size;$('#empty').hidden=!!list.length;
 $('#cards').innerHTML=list.map(p=>`<article class="card kit-card kit-surface-card"><div class="card-top"><div class="place-icon">${p.icon}</div><div><button class="place-title kit-action kit-action--secondary kit-surface-control" data-detail="${p.id}">${escapeHTML(p.name)} ↗</button><div class="place-meta type-small">${p.label} · ≈ ${p.walk} мин пешком</div></div><button class="heart kit-action kit-action--secondary kit-surface-control" data-save="${p.id}" aria-label="Избранное: ${escapeHTML(p.name)}" aria-pressed="${saved.has(p.id)}">${icon('heart')}</button></div><div class="card-bottom">${badge(p)}<button class="locate-place kit-action kit-action--secondary kit-surface-control" data-locate="${p.id}" aria-label="Показать ${escapeHTML(p.name)} на схеме">На схеме ↗</button><span class="wait type-small">${planned()?`${dayLabel()} около ${loadedTime}`:p.report_count?`≈ ${p.people} чел. сейчас`:'Число людей неизвестно'}</span>${planned()?`<button class="check-in-trigger kit-action kit-surface-control" data-plan="${p.id}" ${actionDisabled(p)}>${actionLabel(p)}</button>`:`<span class="load type-small">${p.report_count?p.load+'%':'Нет оценок'}</span>`}</div>${reportSummary(p)}</article>`).join('');
 renderMap(list);
 document.querySelectorAll('[data-locate]').forEach(button => button.onclick = () => {
  if (mobileLayout.matches) {
   setWorkspaceView('map');
   $('#show-map').focus();
   $('#workspace-switch').scrollIntoView({ block: 'nearest' });
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
 const version=++loadVersion, slot=$('#time').value, date=$('#visit-date').value, b=$('#search');
 b.disabled=true;b.setAttribute('aria-busy','true');$('#search-label').textContent='Ищем места…';$('#plan-status').textContent='';
 $('#results-error').hidden=true;$('#results-error').textContent='';
 if($('#detail').open)$('#detail').close();
 if($('#check-in').open)$('#check-in').close();
 if(schematicMap)schematicMap.closePopup();
 document.querySelectorAll('.check-in-trigger').forEach(button=>button.disabled=true);
 try{
  const response=await fetch('/api/places?time='+encodeURIComponent(slot)+'&university='+university+'&date='+date);const data=await response.json();
  if(version!==loadVersion)return;
  if(!response.ok)throw Error(data.error||'Не удалось загрузить места');
  places=data.places;viewMode=data.mode;myPlan=data.my_plan;loadedTime=data.time;loadedDate=data.visit_date;canPlan=data.can_plan;
  $('#result-label').textContent=planned()?`Планы на ${dayLabel()} · ${data.time} ±${data.window_minutes} мин`:'Загруженность сейчас';
  $('#sort').options[0].textContent=planned()?'Сначала меньше планов':'Сначала свободные';
  render();
  const rated=places.filter(p=>p.report_count>0);
  $('#tip').textContent=planned()?'Выбери «Пойду сюда», чтобы добавить себя. Учитываются планы на выбранный день в пределах ±5 минут. Новый выбор заменяет предыдущий план.':rated.length?`Есть свежие оценки для ${rated.length} мест. Примерное число людей — по сообщениям за последние 30 минут.`:'Пока нет свежих оценок. Нажми «Я здесь», чтобы сообщить, сколько людей сейчас в заведении.';
 }catch(error){if(version!==loadVersion)return;places=[];render();$('#empty').hidden=true;$('#results-error').hidden=false;$('#results-error').textContent=error.message||'Не удалось загрузить места. Повторите поиск.';}
 finally{if(version===loadVersion){b.disabled=false;b.removeAttribute('aria-busy');$('#search-label').textContent='Найти место';}}
}
$('#break').onchange=()=>{setTimes();load();};$('#time').onchange=load;$('#visit-date').onchange=load;$('#search').onclick=load;$('#sort').onchange=render;document.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{category=b.dataset.category;document.querySelectorAll('[data-category]').forEach(c=>{c.setAttribute('aria-pressed',b===c);});render();});$('#close-dialog').onclick=()=>$('#detail').close();$('#detail').onclick=e=>{if(e.target===$('#detail'))$('#detail').close();};initMap();setBreaks();load();

viewButtons.forEach(button => button.addEventListener('click', () => setWorkspaceView(button.dataset.view)));
if (clusterPreview && mobileLayout.matches) setWorkspaceView('map');
setInterval(()=>{if(!document.hidden && !document.querySelector("dialog[open]"))load();},60000);
