// Load navigation
fetch('nav.html')
    .then(response => response.text())
    .then(data => {
        document.getElementById('nav-placeholder').innerHTML = data;
        
        // Initialize menu toggle after nav is loaded
        const toggleButton = document.querySelector('.menu-toggle');
        const topnav = document.querySelector('.topnav');

        toggleButton.addEventListener('click', (e) => {
            e.stopPropagation();
            topnav.classList.toggle('expanded');

            toggleButton.textContent =
                topnav.classList.contains('expanded') ? '✕' : '☰';
        });

        document.addEventListener('click', (e) => {
            if (!topnav.contains(e.target)) {
                topnav.classList.remove('expanded');
                toggleButton.textContent = '☰';
            }
        });
    });

// Load footer
fetch('footer.html')
    .then(response => response.text())
    .then(data => {
        document.getElementById('footer-placeholder').innerHTML = data;
    });