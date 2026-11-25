const $ = s => document.querySelector(s);
const escapeHTML = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let selectedMapId = null;
let schematicMap, mapMarkers, resizeMap, visibleMapPlaces = [];
const mobileLayout = matchMedia('(max-width: 730px)');
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
 if($('#time').value!==loadedTime || $('#visit-date').value!==loadedDate || $('#search').disabled){$('#plan-status').textContent='Дождитесь загрузки выбранного времени.';return;}
 const cancel=myPlan?.place_id===id && myPlan.slot===loadedTime;
 if(!cancel && !canPlan){$('#plan-status').textContent='Это время уже прошло. Выберите «Завтра» или более позднее время.';return;}
 document.querySelectorAll('.check-in-trigger, #detail-check-in').forEach(b=>b.disabled=true);
 try{
  const response=await fetch('/api/plans?university='+university+'&date='+loadedDate,{method:cancel?'DELETE':'POST',headers:{'Content-Type':'application/json'},...(cancel?{}:{body:JSON.stringify({place_id:id,time:loadedTime})})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Не удалось сохранить план');
  myPlan=data.my_plan;
  $('#detail').close();
  await load();
  $('#plan-status').textContent=cancel?'План отменён.':'План сохранён. Вы учтены среди тех, кто собирается прийти.';
 }catch(error){$('#plan-status').textContent=error.message;}
 finally{document.querySelectorAll('.check-in-trigger, #detail-check-in').forEach(b=>b.disabled=false);if(places.length)render();}
}
function mapPoint(p){
 const north=(p.lat-ORIGIN.lat)*111195;
 const east=(p.lon-ORIGIN.lon)*111195*Math.cos(ORIGIN.lat*Math.PI/180);
 return {point:[500+north/2.2,500+east/2.2],inside:Math.hypot(north,east)<=1000};
}
function reportSummary(p){
 if(planned())return myPlan?.place_id===p.id?`<span class="visitor-report">Ваш план на ${dayLabel()}: ${escapeHTML(myPlan.slot)}</span>`:'';
 if(!p.current_report || p.current_report.expires_at*1000 <= Date.now()) return '';
 const minutes=Math.max(0,Math.floor((Date.now()-p.current_report.observed_at*1000)/60000));
 return `<span class="visitor-report">● Последняя оценка: ${escapeHTML(p.current_report.people_range.replace('-', '–'))} человек · ${minutes?minutes+' мин назад':'только что'}</span>`;
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
 $('#check-in-submit').disabled=true;$('#check-in-status').textContent='Сохраняем…';
 try{
  const response=await fetch('/api/check-ins?university='+university,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({place_id:id,people_range:range})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Не удалось сохранить ответ');
  const p=places.find(p=>p.id===id);if(p)Object.assign(p,data.place);
  render();
  $('#check-in-status').textContent='Спасибо! Сообщение сохранено и будет видно 30 минут.';
  $('#check-in-submit').textContent='Ответ сохранён';
 }catch(error){$('#check-in-status').textContent=error.message;$('#check-in-submit').disabled=false;}
}
function initMap(){
 mapResizeObserver?.disconnect();if(schematicMap)schematicMap.remove();schematicMap=null;mapMarkers=null;
 resizeMap = null;
 $('#check-in')?.remove();
 const dialog=document.createElement('dialog');dialog.id='check-in';
 dialog.innerHTML=`<button class="check-in-close" type="button" aria-label="Закрыть отметку">×</button><div class="check-in-eyebrow">ПОМОГИ ДРУГИМ СТУДЕНТАМ</div><h2>Я здесь</h2><p id="check-in-name"></p><form id="check-in-form"><fieldset><legend>Сколько людей сейчас в заведении?</legend><div class="people-options">${['0-5','5-10','10-15','15-20'].map(range=>`<label><input type="radio" name="people_range" value="${range}" required><span>${range.replace('-','–')}<small>человек</small></span></label>`).join('')}</div></fieldset><p class="check-in-note">Примерной оценки достаточно. Оценка учитывается в загруженности 30 минут. Процент — средняя оценка числа людей относительно 20 посетителей.</p><button id="check-in-submit" class="check-in-primary" type="submit">Поделиться</button><p id="check-in-status" role="status" aria-live="polite"></p></form>`;
 document.body.append(dialog);
 dialog.querySelector('.check-in-close').onclick=()=>dialog.close();
 dialog.onclick=e=>{if(e.target===dialog)dialog.close();};
 $('#check-in-form').onsubmit=submitCheckIn;

 $('#map').innerHTML = `<div class="schematic-head"><span>ОКРЕСТНОСТИ ${universities[university].name}</span><span class="radius-pill">↗ Радиус 1 км</span></div><div class="schematic-canvas" id="schematic-view" aria-label="Схема: используйте плюс и минус для масштаба, стрелки для перемещения"></div><div class="schematic-legend"><span><i class="neutral"></i>Нет оценок</span><span><i class="green"></i>Свободно</span><span><i class="amber"></i>Умеренно</span><span><i class="red"></i>Загружено</span><small>По оценкам посетителей</small></div><div id="map-selection" class="map-selection"></div><div class="schematic-credit"><span>Схема района · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a></span><span>Север ↑</span></div>`;
 if(!window.L){$('#schematic-view').textContent='Не удалось загрузить карту. Обновите страницу.';return;}
 const bounds=L.latLngBounds([[0,0],[1000,1000]]);
 schematicMap=L.map('schematic-view',{crs:L.CRS.Simple,minZoom:-5,maxBounds:bounds,maxBoundsViscosity:1,maxZoom:2,zoomSnap:0.1,zoomDelta:0.25,scrollWheelZoom:true,wheelDebounceTime:40,wheelPxPerZoomLevel:180,zoomAnimation:true,zoomAnimationThreshold:4,markerZoomAnimation:true,fadeAnimation:false,inertia:true,attributionControl:false});
 L.imageOverlay('/static/'+universities[university].map+'?v=universities',bounds,{interactive:false}).addTo(schematicMap);
 const resetView=()=>{schematicMap.invalidateSize();schematicMap.setMinZoom(-5);const zoom=schematicMap.getBoundsZoom(bounds);schematicMap.setMinZoom(zoom);schematicMap.fitBounds(bounds,{animate:false});};
 const mapView = $('#schematic-view');
 let needsFit = !mapView.clientWidth;
 if (!needsFit) resetView();
 else schematicMap.setView(bounds.getCenter(), -2);
 L.marker([500,500],{icon:L.divIcon({className:'campus-map-icon',html:`<span>✦</span><b>${universities[university].origin_label}</b>`,iconSize:[39,39],iconAnchor:[19.5,19.5]}),zIndexOffset:1000,title:universities[university].origin_label}).addTo(schematicMap);
 mapMarkers=L.layerGroup().addTo(schematicMap);
 const reset=L.control({position:'topright'});
 reset.onAdd=()=>{const button=L.DomUtil.create('button','map-reset');button.type='button';button.textContent='Весь район';button.title='Показать весь радиус 1 км';L.DomEvent.disableClickPropagation(button);button.onclick=resetView;return button;};reset.addTo(schematicMap);
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
  schematicMap.flyTo(mapPoint(p).point,Math.max(schematicMap.getZoom(),0.5),{duration:0.35});
 }
 document.querySelectorAll('.card').forEach(card=>card.classList.toggle('map-selected',card.querySelector('[data-locate]')?.dataset.locate===id));
}
function renderMap(list){
 visibleMapPlaces=list;
 const inRange=list.filter(p=>mapPoint(p).inside);
 const p=inRange.find(p=>p.id===selectedMapId)||inRange[0];
 selectedMapId=p?.id||null;
 if(mapMarkers){mapMarkers.clearLayers();inRange.forEach(place=>{
  const icon=L.divIcon({className:`load-map-icon ${place.tone} ${place.id===selectedMapId?'is-selected':''}`,html:`<span>${place.icon}</span><b>${countLabel(place)}</b>`,iconSize:[70,31],iconAnchor:[35,15.5]});
  const marker=L.marker(mapPoint(place).point,{icon,title:`${place.name}: ${place.status} · ${countLabel(place)}`,zIndexOffset:place.id===selectedMapId?500:0}).addTo(mapMarkers);
  marker.bindTooltip(`${escapeHTML(place.name)} · ${countLabel(place)}`);
  marker.on('click',()=>{selectedMapId=place.id;renderMap(visibleMapPlaces);const popup=L.popup({className:'check-in-popup',closeButton:true}).setLatLng(mapPoint(place).point).setContent(`<strong>${escapeHTML(place.name)}</strong><p>${planned()?`План на ${dayLabel()}, около ${loadedTime}`:'Сколько людей здесь сейчас?'}</p><button type="button" class="popup-check-in check-in-trigger" ${actionDisabled(place)}>${actionLabel(place)}</button>`).openOn(schematicMap);popup.getElement().querySelector('.popup-check-in').onclick=()=>choosePlace(place.id);document.querySelectorAll('.card').forEach(card=>card.classList.toggle('map-selected',card.querySelector('[data-locate]')?.dataset.locate===place.id));});
  marker.on('dblclick',()=>details(place.id));
 });}
 if(!p){$('#map-selection').textContent='Нет заведений для выбранного фильтра';return;}
 $('#map-selection').innerHTML=`<div class="selection-icon">${p.icon}</div><div><button class="map-place-detail">${escapeHTML(p.name)} ↗</button><span>≈ ${p.walk} мин пешком · ${p.distance} м по прямой</span>${reportSummary(p)}</div><button class="check-in-trigger" type="button" ${actionDisabled(p)}>${actionLabel(p)}</button>`;
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
 $('#detail-content').innerHTML=`<div class="detail-icon">${p.icon}</div><h2 class="detail-title">${escapeHTML(p.name)}</h2><p class="detail-text">${p.label} · ≈ ${p.walk} мин пешком от ${universities[university].name}</p><span class="badge ${p.tone}"><i></i>${p.status}</span><p class="detail-text">${description}</p><p class="detail-text">${escapeHTML(p.address)}<br>${escapeHTML(p.hours)}</p><a class="source-link" href="${p.source_url}" target="_blank" rel="noopener noreferrer">Место в OpenStreetMap ↗</a><br><a class="source-link" href="https://yandex.ru/maps/?rtext=${ORIGIN.lat},${ORIGIN.lon}~${p.lat},${p.lon}&rtt=pd" target="_blank" rel="noopener noreferrer">Построить пеший маршрут ↗</a>${reportSummary(p)}<button class="check-in-primary" id="detail-check-in" type="button" ${actionDisabled(p)}>${actionLabel(p)}</button>`;
 $('#detail').showModal();$('#detail-check-in').onclick=()=>{$('#detail').close();choosePlace(id);};locate(id);
}
function render(){
 $('#plan-day').hidden=!planned();
 $('#plan-day-note').textContent=planned()&&!canPlan?'Это время уже прошло. Выберите «Завтра» или более позднее время.':'';
 const sort=$('#sort').value;
 const list=places.filter(p=>category==='all'||(category==='favorites'?saved.has(p.id):p.category===category)).sort((a,b)=>Number(saved.has(b.id))-Number(saved.has(a.id))||(sort==='walk'?a.walk-b.walk:planned()?a.planned_count-b.planned_count:a.load-b.load));
 $('#count').textContent=list.length;$('#fav-count').textContent=saved.size;$('#empty').hidden=!!list.length;
 $('#cards').innerHTML=list.map(p=>`<article class="card"><div class="card-top"><div class="place-icon">${p.icon}</div><div><button class="place-title" data-detail="${p.id}">${escapeHTML(p.name)} ↗</button><div class="place-meta">${p.label} · ≈ ${p.walk} мин пешком</div></div><button class="heart ${saved.has(p.id)?'saved':''}" data-save="${p.id}" aria-label="${saved.has(p.id)?'Удалить из':'Добавить в'} избранное" aria-pressed="${saved.has(p.id)}">${saved.has(p.id)?'♥':'♡'}</button></div><div class="card-bottom"><span class="badge ${p.tone}"><i></i>${p.status}</span><button class="locate-place" data-locate="${p.id}" aria-label="Показать ${escapeHTML(p.name)} на схеме">На схеме ↗</button><span class="wait">${planned()?`${dayLabel()} около ${loadedTime}`:p.report_count?`≈ ${p.people} чел. сейчас`:'Число людей неизвестно'}</span>${planned()?`<button class="check-in-trigger" data-plan="${p.id}" ${actionDisabled(p)}>${actionLabel(p)}</button>`:`<span class="load">${p.report_count?p.load+'%':'Нет оценок'}</span>`}</div>${reportSummary(p)}</article>`).join('');
 renderMap(list);
 document.querySelectorAll('[data-locate]').forEach(button => button.onclick = () => {
  if (mobileLayout.matches) {
   setWorkspaceView('map');
   $('#show-map').focus();
   $('#workspace-switch').scrollIntoView({ block: 'nearest' });
  }
  locate(button.dataset.locate);
 });
 document.querySelectorAll('[data-save]').forEach(b=>b.onclick=()=>save(b.dataset.save));
 document.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>details(b.dataset.detail));
 document.querySelectorAll('[data-plan]').forEach(b=>b.onclick=()=>updatePlan(b.dataset.plan));
 $('#empty').textContent=category==='favorites'?'Пока нет избранных заведений рядом с этим вузом. Добавь место сердечком ♡':'Для выбранного фильтра заведений нет.';
 $('.schematic-legend').innerHTML=planned()?'<span>Число людей, планирующих прийти ±5 минут</span>':'<span><i class="neutral"></i>Нет оценок</span><span><i class="green"></i>Свободно</span><span><i class="amber"></i>Умеренно</span><span><i class="red"></i>Загружено</span><small>По оценкам посетителей</small>';
}
async function load(){
 const version=++loadVersion, slot=$('#time').value, date=$('#visit-date').value, b=$('#search');
 b.disabled=true;b.textContent='Ищем места…';$('#plan-status').textContent='';
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
 }catch(error){if(version!==loadVersion)return;places=[];render();$('#empty').hidden=true;$('#cards').textContent=error.message||'Не удалось загрузить места. Повторите поиск.';}
 finally{if(version===loadVersion){b.disabled=false;b.innerHTML='Найти место <span>↗</span>';}}
}
$('#break').onchange=()=>{setTimes();load();};$('#time').onchange=load;$('#visit-date').onchange=load;$('#search').onclick=load;$('#sort').onchange=render;document.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{category=b.dataset.category;document.querySelectorAll('[data-category]').forEach(c=>{c.classList.toggle('selected',b===c);c.setAttribute('aria-pressed',b===c);});render();});$('#close-dialog').onclick=()=>$('#detail').close();$('#detail').onclick=e=>{if(e.target===$('#detail'))$('#detail').close();};initMap();setBreaks();load();

viewButtons.forEach(button => button.addEventListener('click', () => setWorkspaceView(button.dataset.view)));
setInterval(()=>{if(!document.hidden && !document.querySelector("dialog[open]"))load();},60000);
