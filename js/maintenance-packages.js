        const packageData = {
            'single-home': [
                { level: 'Basic', monthly: 160, retainer: '2 hours', rollover: '—', discount: '—', priority: false, annual: false, quarterly: false, onCall: false, tenant: false },
                { level: 'Pro', monthly: 200, retainer: '2 hours', rollover: '1 hour', discount: '5%', priority: true, annual: true, quarterly: false, onCall: false, tenant: false },
                { level: 'Premium', monthly: 350, retainer: '4 hours', rollover: '2 hours', discount: '10%', priority: true, annual: true, quarterly: true, onCall: true, tenant: false },
            ],
            portfolio: [
                { level: 'Basic', monthly: 300, retainer: '4-hour pool', rollover: '—', discount: '—', priority: false, annual: false, quarterly: false, onCall: false, tenant: false },
                { level: 'Pro', monthly: 400, retainer: '6-hour pool', rollover: '2 hours', discount: '5%', priority: true, annual: true, quarterly: false, onCall: false, tenant: true },
                { level: 'Premium', monthly: 700, retainer: '10-hour pool', rollover: '4 hours', discount: '10%', priority: true, annual: true, quarterly: true, onCall: true, tenant: true },
            ],
        };
        const featureLabels = [
            ['priority', 'Priority scheduling'],
            ['annual', 'Annual home inspection'],
            ['quarterly', 'Quarterly home inspection'],
            ['onCall', 'On-call service'],
            ['tenant', 'Tenant coordination'],
        ];
        const packageGrid = document.getElementById('package-grid');
        const packageTabs = Array.from(document.querySelectorAll('[data-package-type]'));

        function renderPackages(type) {
            packageGrid.innerHTML = packageData[type].map((plan) => `
                <article class="package-card" data-level="${plan.level.toLowerCase()}">
                    <h2>${plan.level}</h2>
                    <p class="package-price">$${plan.monthly}<span> / month</span></p>
                    <p class="package-retainer">${plan.retainer} included</p>
                    <dl class="package-facts">
                        <dt>Rollover</dt><dd>${plan.rollover}</dd>
                        <dt>Service discount</dt><dd>${plan.discount}</dd>
                    </dl>
                    <ul class="package-features">
                        <li><span>2-hour minimum</span><span class="feature-status is-included">Waived</span></li>
                        ${featureLabels.map(([key, label]) => `
                            <li><span>${label}</span><span class="feature-status ${plan[key] ? 'is-included' : ''}">${plan[key] ? 'Included' : '—'}</span></li>
                        `).join('')}
                    </ul>
                </article>
            `).join('');
        }

        packageTabs.forEach((tab) => tab.addEventListener('click', () => {
            packageTabs.forEach((item) => item.setAttribute('aria-selected', String(item === tab)));
            renderPackages(tab.dataset.packageType);
        }));
        renderPackages('single-home');
