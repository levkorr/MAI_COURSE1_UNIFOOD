const status = document.querySelector('#place-card-example-status');

document.querySelectorAll('[data-save]').forEach(button => {
  button.addEventListener('click', () => {
    const selected = button.getAttribute('aria-pressed') === 'true';
    button.setAttribute('aria-pressed', String(!selected));
  });
});

const actions = {
  detail: 'открыть детали места',
  locate: 'показать место на карте',
  plan: 'отменить сохранённый план',
};

for (const [action, label] of Object.entries(actions)) {
  document.querySelectorAll(`[data-${action}]:not([hidden])`).forEach(control => {
    control.addEventListener('click', () => {
      status.textContent = `Действие в приложении — ${label}.`;
    });
  });
}
