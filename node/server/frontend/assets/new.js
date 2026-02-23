(function () {
  const form = document.getElementById('new-form');
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
    const title = document.getElementById('post-title').value;
    const content = document.getElementById('post-content').value;
    try {
      const data = await window.Api.request('/api/posts', 'POST', { title, content });
      location.href = `/post/${data.post.id}`;
    } catch (err) {
      showError(err.message);
    }
  });

  document.getElementById('back').addEventListener('click', () => {
    location.href = '/main';
  });

  window.Api.request('/api/me', 'GET').catch(() => {
    window.Api.clearToken();
    location.href = '/';
  });
})();
