const styles = getComputedStyle(document.querySelector('.kit-colors'));
const picker = document.createElement('span');
document.body.append(picker);

function resolveColor(token) {
  picker.style.color = `var(${token})`;
  return getComputedStyle(picker).color;
}

function luminance(color) {
  const rgb = color.match(/\d+/g).map(channel => Number(channel) / 255);
  const linear = rgb.map(channel => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

for (const specimen of document.querySelectorAll('[data-token]')) {
  specimen.querySelector('output').textContent = styles.getPropertyValue(specimen.dataset.token).trim();
}

for (const specimen of document.querySelectorAll('[data-foreground]')) {
  const foreground = luminance(resolveColor(specimen.dataset.foreground));
  const background = luminance(resolveColor(specimen.dataset.background));
  const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  specimen.querySelector('output').textContent = `${contrast.toFixed(2)}:1`;
}

picker.remove();

function showTypeMetrics() {
  for (const specimen of document.querySelectorAll('[data-type-specimen]')) {
    const type = getComputedStyle(specimen);
    specimen.parentElement.querySelector('output').textContent =
      `${type.fontSize} · вес ${type.fontWeight} · строка ${type.lineHeight} · трекинг ${type.letterSpacing}`;
  }
}

showTypeMetrics();
matchMedia('(max-width: 730px)').addEventListener('change', showTypeMetrics);

function showSizeMetrics() {
  for (const specimen of document.querySelectorAll('[data-size-token]')) {
    const measure = document.createElement('span');
    measure.style.inlineSize = `var(${specimen.dataset.sizeToken})`;
    measure.style.position = 'absolute';
    measure.style.visibility = 'hidden';
    specimen.append(measure);
    const value = getComputedStyle(measure).inlineSize;
    measure.remove();
    specimen.querySelector('output').textContent = value;
  }
}

showSizeMetrics();
matchMedia('(max-width: 730px)').addEventListener('change', showSizeMetrics);

for (const specimen of document.querySelectorAll('[data-surface-token]')) {
  const value = getComputedStyle(specimen).getPropertyValue(specimen.dataset.surfaceToken);
  specimen.querySelector('output').textContent = value.trim();
}

const surfaceDialog = document.querySelector('#surface-dialog');
document.querySelector('#open-surface-dialog').addEventListener('click', () => surfaceDialog.showModal());

const interactionToggle = document.querySelector('#interaction-toggle');
interactionToggle.addEventListener('click', () => {
  const selected = interactionToggle.getAttribute('aria-pressed') !== 'true';
  interactionToggle.setAttribute('aria-pressed', String(selected));
  interactionToggle.querySelector('span').textContent = selected ? '· Выбрано' : '· Не выбрано';
});

const interactionForm = document.querySelector('#interaction-form');
const interactionName = document.querySelector('#interaction-name');
const interactionError = document.querySelector('#interaction-error');
const interactionStatus = document.querySelector('#interaction-status');

function clearInteractionError() {
  interactionName.removeAttribute('aria-invalid');
  interactionName.setAttribute('aria-describedby', 'interaction-hint');
  interactionError.hidden = true;
}

interactionName.addEventListener('input', () => {
  interactionStatus.textContent = '';
  if (interactionName.value.trim()) clearInteractionError();
});

interactionForm.addEventListener('submit', event => {
  event.preventDefault();
  if (!interactionName.value.trim()) {
    interactionStatus.textContent = '';
    interactionName.setAttribute('aria-invalid', 'true');
    interactionName.setAttribute('aria-describedby', 'interaction-hint interaction-error');
    interactionError.hidden = false;
    interactionName.focus();
    return;
  }

  clearInteractionError();
  interactionStatus.textContent = 'Поле заполнено.';
});
