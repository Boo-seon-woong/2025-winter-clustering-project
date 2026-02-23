(function () {
  const postsEl = document.getElementById('posts');

  function authorLabel(post) {
    return post.name || post.email || '';
  }

  function renderPosts(posts) {
    if (!posts || posts.length === 0) {
      postsEl.innerHTML = '<div class="post"><p>No posts yet.</p></div>';
      return;
    }
    postsEl.innerHTML = posts.map((post) => {
      return `
        <div class="post">
          <h3><a href="/post/${post.id}">${post.title}</a></h3>
          <span>${authorLabel(post)} · ${new Date(post.created_at).toLocaleString()}</span>
        </div>
      `;
    }).join('');
  }

  async function loadMain() {
    await window.Api.request('/api/me', 'GET');
    const list = await window.Api.request('/api/posts', 'GET');
    renderPosts(Array.isArray(list.posts) ? list.posts : []);
  }

  function handleWsMessage(message) {
    if (!message || !message.event) {
      return;
    }
    if (message.event === 'post:new') {
      const post = message.payload;
      if (!post) {
        return;
      }
      const existing = Array.from(postsEl.querySelectorAll('a')).some((a) => a.getAttribute('href') === `/post/${post.id}`);
      if (!existing) {
        const node = document.createElement('div');
        node.className = 'post';
        node.innerHTML = `<h3><a href="/post/${post.id}">${post.title}</a></h3><span>${authorLabel(post)} · ${new Date(post.created_at).toLocaleString()}</span>`;
        if (postsEl.firstChild) {
          postsEl.prepend(node);
        } else {
          postsEl.appendChild(node);
        }
      }
    }
  }

  document.getElementById('new-post').addEventListener('click', () => {
    location.href = '/new';
  });

  document.getElementById('logout').addEventListener('click', async () => {
    await window.Api.request('/api/logout', 'POST', {});
    window.Api.clearToken();
    location.href = '/';
  });

  window.Ws.connect(handleWsMessage);

  loadMain().catch(() => {
    window.Api.clearToken();
    location.href = '/';
  });
})();
