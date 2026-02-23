(function () {
  const form = document.getElementById('register-form');
  const errorBox = document.getElementById('error');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.style.display = 'block';
  }

  function clearError() {
    errorBox.style.display = 'none';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    const email = document.getElementById('reg-email').value;
    const name = document.getElementById('reg-name').value;
    const password = document.getElementById('reg-password').value;
    try {
      const data = await window.Api.request('/api/register', 'POST', { email, name, password });
      window.Api.setToken(data.token);
      location.href = '/main';
    } catch (err) {
      showError(err.message);
    }
  });

  document.getElementById('go-back').addEventListener('click', () => {
    location.href = '/';
  });
})();
