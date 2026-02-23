(function () {
  const form = document.getElementById('login-form');
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
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    try {
      const data = await window.Api.request('/api/login', 'POST', { email, password });
      window.Api.setToken(data.token);
      location.href = '/main';
    } catch (err) {
      showError(err.message);
    }
  });

  document.getElementById('go-register').addEventListener('click', () => {
    location.href = '/register';
  });
})();
