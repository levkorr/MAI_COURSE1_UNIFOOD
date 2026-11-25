const status = document.querySelector('#place-card-example-status');

document.querySelectorAll('[data-card-favorite]').forEach(button => {
  button.addEventListener('click', () => {
    const selected = button.getAttribute('aria-pressed') === 'true';
    button.setAttribute('aria-pressed', String(!selected));
  });
});

document.querySelectorAll('[data-card-message]').forEach(control => {
  control.addEventListener('click', event => {
    event.preventDefault();
    status.textContent = `Действие в приложении — ${control.dataset.cardMessage.toLowerCase()}.`;
  });
});
