    if (window.StickmanPortal && typeof window.StickmanPortal.applyAccountNavDestination === 'function') {
        window.StickmanPortal.applyAccountNavDestination();
    }

    const toggleButton = document.querySelector('.menu-toggle');
    const topnav = document.querySelector('.topnav');

    toggleButton.addEventListener('click', (e) => {
        e.stopPropagation();
        topnav.classList.toggle('expanded');
        toggleButton.setAttribute('aria-expanded', String(topnav.classList.contains('expanded')));
    });

    document.addEventListener('click', (e) => {
        if (!topnav.contains(e.target)) {
            topnav.classList.remove('expanded');
            toggleButton.setAttribute('aria-expanded', 'false');
        }
    });

    // Preload pages on hover
    const preloadLinks = document.querySelectorAll('.nav-links a, .logo-bubble a');
    preloadLinks.forEach(link => {
        link.addEventListener('mouseenter', () => {
            const href = link.getAttribute('href');
            if (href && !document.querySelector(`link[href="${href}"]`)) {
                const preloadLink = document.createElement('link');
                preloadLink.rel = 'preload';
                preloadLink.href = href;
                preloadLink.as = 'document';
                document.head.appendChild(preloadLink);
            }
        });
    });
