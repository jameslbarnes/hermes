
        // Claim handle modal
        let claimCheckTimeout;

        function openClaimModal() {
            document.getElementById('claim-modal').classList.remove('hidden');
            document.getElementById('claim-handle-input').focus();
        }

        function closeClaimModal() {
            document.getElementById('claim-modal').classList.add('hidden');
            document.getElementById('claim-handle-input').value = '';
            document.getElementById('claim-display-name').value = '';
            document.getElementById('claim-bio').value = '';
            document.getElementById('claim-handle-status').textContent = '';
            document.getElementById('claim-status').style.display = 'none';
        }

        async function checkClaimHandle() {
            clearTimeout(claimCheckTimeout);
            const input = document.getElementById('claim-handle-input');
            const status = document.getElementById('claim-handle-status');
            const btn = document.getElementById('claim-submit');
            let handle = input.value.toLowerCase().replace(/[^a-z0-9_]/g, '');

            input.value = handle;

            if (handle.length < 3) {
                status.textContent = handle.length > 0 ? 'Handle must be at least 3 characters' : '';
                status.style.color = 'var(--fg-muted)';
                btn.disabled = true;
                return;
            }

            if (!/^[a-z]/.test(handle)) {
                status.textContent = 'Handle must start with a letter';
                status.style.color = '#e57373';
                btn.disabled = true;
                return;
            }

            status.textContent = 'Checking...';
            status.style.color = 'var(--fg-muted)';

            claimCheckTimeout = setTimeout(async () => {
                try {
                    const res = await fetch(`/api/identity/check/${handle}`);
                    const data = await res.json();

                    if (data.available) {
                        status.textContent = `@${handle} is available`;
                        status.style.color = '#81c784';
                        btn.disabled = false;
                    } else {
                        status.textContent = `@${handle} is taken`;
                        status.style.color = '#e57373';
                        btn.disabled = true;
                    }
                } catch (err) {
                    status.textContent = 'Error checking availability';
                    status.style.color = '#e57373';
                    btn.disabled = true;
                }
            }, 300);
        }

        async function submitClaimHandle() {
            const handle = document.getElementById('claim-handle-input').value;
            const displayName = document.getElementById('claim-display-name').value;
            const bio = document.getElementById('claim-bio').value.trim();
            const status = document.getElementById('claim-status');
            const btn = document.getElementById('claim-submit');
            const effectiveKey = getEffectiveKey();

            if (!effectiveKey) {
                status.textContent = 'No identity key found';
                status.style.display = 'block';
                status.style.color = '#e57373';
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Claiming...';

            try {
                const res = await fetch('/api/identity/claim', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        secret_key: effectiveKey,
                        handle: handle,
                        displayName: displayName || undefined,
                        bio: bio || undefined
                    })
                });

                const data = await res.json();

                if (res.ok) {
                    status.textContent = `Success! You are now @${data.handle}`;
                    status.style.display = 'block';
                    status.style.color = '#81c784';

                    // Update sidebar
                    const identityLink = document.getElementById('identity-link');
                    if (identityLink) {
                        identityLink.innerHTML = `
                            <span class="identity-label">Logged in as</span>
                            <a href="/u/${escapeHtml(data.handle)}" class="identity-handle">@${escapeHtml(data.handle)}</a>
                            <a href="/settings" class="sidebar-btn">Settings</a>
                            <a href="#" onclick="signOut(); return false;" style="display:block;font-family:'IBM Plex Mono',monospace;font-size:0.7rem;color:var(--fg-muted);margin-top:0.5rem;">Sign out</a>
                        `;
                    }

                    setTimeout(() => closeClaimModal(), 1500);
                } else {
                    status.textContent = data.error || 'Failed to claim handle';
                    status.style.display = 'block';
                    status.style.color = '#e57373';
                    btn.disabled = false;
                    btn.textContent = 'Claim Handle';
                }
            } catch (err) {
                status.textContent = 'Network error';
                status.style.display = 'block';
                status.style.color = '#e57373';
                btn.disabled = false;
                btn.textContent = 'Claim Handle';
            }
        }
    
