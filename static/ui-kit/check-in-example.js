const opener = document.querySelector('#open-check-in');
const dialog = document.querySelector('#check-in');
const form = dialog.querySelector('form');
const submit = form.querySelector('[type="submit"]');
const status = form.querySelector('[role="status"]');

opener.addEventListener('click', () => {
  form.reset();
  submit.disabled = true;
  status.textContent = '';
  status.classList.remove('kit-feedback--success');
  dialog.showModal();
});

dialog.querySelector('.check-in-close').addEventListener('click', () => dialog.close());
form.addEventListener('change', () => {
  submit.disabled = false;
  submit.removeAttribute('aria-disabled');
  status.textContent = '';
  status.classList.remove('kit-feedback--success');
});
form.addEventListener('submit', event => {
  event.preventDefault();
  if (submit.getAttribute('aria-disabled') === 'true') return;
  status.classList.add('kit-feedback--success');
  status.textContent = 'В примере оценка принята.';
  submit.setAttribute('aria-disabled', 'true');
});
dialog.addEventListener('close', () => {
  submit.removeAttribute('aria-disabled');
  opener.focus();
});
