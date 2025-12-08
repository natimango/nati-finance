function toggleNav(id) {
    const nav = document.getElementById(id);
    if (!nav) return;
    nav.classList.toggle('is-open');
}

function closeNav(id) {
    const nav = document.getElementById(id);
    if (!nav) return;
    nav.classList.remove('is-open');
}
