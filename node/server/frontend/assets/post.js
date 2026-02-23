(function () {
  const titleEl = document.getElementById('post-title');
  const metaEl = document.getElementById('post-meta');
  const contentEl = document.getElementById('post-content');
  const errorEl = document.getElementById('error');

  function authorLabel(post) {
    return post.name || post.email || '';
  }

  async function loadPost() {
    const parts = location.pathname.split('/');
    const id = parts[2];
    if (!id) {
      throw new Error('invalid post');
    }
    const data = await window.Api.request(`/api/posts/${id}`, 'GET');
    const post = data.post;
    titleEl.textContent = post.title;
    metaEl.textContent = `${authorLabel(post)} · ${new Date(post.created_at).toLocaleString()}`;
    contentEl.textContent = post.content;
  }

  document.getElementById('back').addEventListener('click', () => {
    location.href = '/main';
  });

  loadPost().catch((err) => {
    errorEl.textContent = err.message || 'failed to load post';
    errorEl.style.display = 'block';
  });
})();
