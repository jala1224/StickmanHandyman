    // Load projects and create cards with interactive gallery view
    fetch('projects.json')
        .then(response => response.json())
        .then(projects => {
            const grid = document.getElementById('projects-grid');
            const preloadedImagePaths = new Set();

            function preloadImage(src) {
                if (!src || preloadedImagePaths.has(src)) {
                    return;
                }

                preloadedImagePaths.add(src);
                const preloadImg = new Image();
                preloadImg.decoding = 'async';
                preloadImg.src = src;
            }

            function preloadAdjacentProjectImages(projectIdx, imageIdx) {
                const project = projects[projectIdx];
                const imageCount = project.images.length;

                if (imageCount < 2) {
                    return;
                }

                const adjacentIndexes = new Set([
                    (imageIdx + 1) % imageCount,
                    (imageIdx - 1 + imageCount) % imageCount
                ]);

                adjacentIndexes.forEach((adjacentIdx) => {
                    preloadImage(`images/${project.images[adjacentIdx]}`);
                });
            }

            projects.forEach((project, idx) => {
                const card = document.createElement('div');
                card.className = 'project-card';
                card.dataset.index = idx;

                const img = document.createElement('img');
                img.src = `images/${project.preview || project.images[0]}`;
                img.alt = project.name;
                img.loading = "lazy";
                // Don't force dimensions - let CSS handle sizing

                const countPill = document.createElement('div');
                countPill.className = 'project-card-count-pill';
                countPill.textContent = `${project.images.length} image${project.images.length === 1 ? '' : 's'}`;

                const title = document.createElement('h3');
                title.textContent = project.name;

                card.appendChild(countPill);
                card.appendChild(img);
                card.appendChild(title);
                card.addEventListener('click', () => openGallery(idx));
                grid.appendChild(card);
            });

            // Modal overlay for gallery view
            const modal = document.createElement('div');
            modal.id = 'gallery-modal';
            modal.style.display = 'none';
            modal.innerHTML = `
                <div class="gallery-viewer">
                    <button class="close-modal" title="Close">&times;</button>
                    <div class="gallery-image-area">
                        <div class="gallery-count-pill"></div>
                        <img class="gallery-large-img" src="" alt="" />
                    </div>
                    <div class="gallery-header">
                        <button class="gallery-prev" title="Previous">&#8592;</button>
                        <div class="gallery-title"></div>
                        <button class="gallery-next" title="Next">&#8594;</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            let currentProjectIdx = 0;
            let currentImgIdx = 0;
            let touchStartX = 0;
            let touchStartY = 0;
            let lockedScrollY = 0;
            const imageArea = modal.querySelector('.gallery-image-area');
            const largeImg = modal.querySelector('.gallery-large-img');
            const countPill = modal.querySelector('.gallery-count-pill');

            function shouldLockBackgroundScroll() {
                return window.matchMedia('(max-width: 1024px), (hover: none) and (pointer: coarse)').matches;
            }

            function lockBackgroundScroll() {
                if (!shouldLockBackgroundScroll() || document.body.classList.contains('gallery-scroll-locked')) {
                    return;
                }

                lockedScrollY = window.scrollY || window.pageYOffset || 0;
                document.body.classList.add('gallery-scroll-locked');
                document.body.style.top = `-${lockedScrollY}px`;
            }

            function unlockBackgroundScroll() {
                if (!document.body.classList.contains('gallery-scroll-locked')) {
                    return;
                }

                document.body.classList.remove('gallery-scroll-locked');
                document.body.style.top = '';
                window.scrollTo(0, lockedScrollY);
            }

            function updateMobileImageAreaOrientation() {
                if (!window.matchMedia('(max-width: 768px)').matches) {
                    imageArea.classList.remove('is-portrait', 'is-landscape');
                    return;
                }

                if (!largeImg.naturalWidth || !largeImg.naturalHeight) {
                    return;
                }

                const isPortrait = largeImg.naturalHeight > largeImg.naturalWidth;
                imageArea.classList.toggle('is-portrait', isPortrait);
                imageArea.classList.toggle('is-landscape', !isPortrait);
            }

            function openGallery(projectIdx) {
                currentProjectIdx = projectIdx;
                currentImgIdx = 0;
                showGalleryImage();
                modal.style.display = 'flex';
                grid.parentElement.insertAdjacentElement('afterend', modal);
                lockBackgroundScroll();
            }

            function closeGallery() {
                modal.style.display = 'none';
                unlockBackgroundScroll();
            }

            function showGalleryImage() {
                const project = projects[currentProjectIdx];
                const imgList = project.images;
                const currentSrc = `images/${imgList[currentImgIdx]}`;
                largeImg.onload = updateMobileImageAreaOrientation;
                largeImg.src = currentSrc;
                largeImg.alt = project.name;
                modal.querySelector('.gallery-title').textContent = project.name;
                countPill.textContent = `${currentImgIdx + 1} / ${imgList.length}`;
                preloadedImagePaths.add(currentSrc);
                preloadAdjacentProjectImages(currentProjectIdx, currentImgIdx);

                if (largeImg.complete) {
                    updateMobileImageAreaOrientation();
                }
            }

            function showPreviousImage() {
                const project = projects[currentProjectIdx];
                currentImgIdx = (currentImgIdx - 1 + project.images.length) % project.images.length;
                showGalleryImage();
            }

            function showNextImage() {
                const project = projects[currentProjectIdx];
                currentImgIdx = (currentImgIdx + 1) % project.images.length;
                showGalleryImage();
            }

            modal.querySelector('.close-modal').onclick = closeGallery;
            modal.querySelector('.gallery-prev').onclick = function(e) {
                e.stopPropagation();
                showPreviousImage();
            };
            modal.querySelector('.gallery-next').onclick = function(e) {
                e.stopPropagation();
                showNextImage();
            };

            imageArea.addEventListener('touchstart', (e) => {
                const touch = e.changedTouches[0];
                touchStartX = touch.clientX;
                touchStartY = touch.clientY;
            }, { passive: true });

            imageArea.addEventListener('touchend', (e) => {
                const touch = e.changedTouches[0];
                const deltaX = touch.clientX - touchStartX;
                const deltaY = touch.clientY - touchStartY;
                const swipeThreshold = 40;

                // Handle horizontal swipes only and ignore mostly vertical gestures.
                if (Math.abs(deltaX) > swipeThreshold && Math.abs(deltaX) > Math.abs(deltaY)) {
                    if (deltaX < 0) {
                        showNextImage();
                    } else {
                        showPreviousImage();
                    }
                }
            }, { passive: true });

            // Close modal on background click
            modal.onclick = function(e) {
                if (e.target === modal) closeGallery();
            };

            window.addEventListener('resize', updateMobileImageAreaOrientation);
        })
        .catch(error => console.error('Error loading projects:', error));
