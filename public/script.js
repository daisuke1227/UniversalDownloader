document.addEventListener('DOMContentLoaded', () => {
    const themeToggle = document.getElementById('themeToggle');
    const themeLabel = document.getElementById('themeLabel');
    const form = document.getElementById('dlForm');
    const submitBtn = document.getElementById('submitBtn');
    const downloadTypeSelect = document.getElementById('downloadType');
    const audioOptions = document.getElementById('audio-options');
    const videoOptions = document.getElementById('video-options');
    const videoFormatOption = document.getElementById('video-format-option');
    const audioFormatSelect = document.getElementById('audioFormat');
    const wavWarning = document.getElementById('wav-warning');
    const statusDiv = document.getElementById('status');
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)');

    function updateThemeUI(isDark) {
        document.documentElement.classList.toggle('dark', isDark);
        themeToggle.checked = isDark;
        themeLabel.textContent = isDark ? 'Dark Mode' : 'Light Mode';
    }

    function applyTheme() {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme) {
            updateThemeUI(savedTheme === 'dark');
        } else {
            updateThemeUI(systemPrefersDark.matches);
        }
    }

    themeToggle.addEventListener('change', (e) => {
        const newTheme = e.target.checked ? 'dark' : 'light';
        localStorage.setItem('theme', newTheme);
        updateThemeUI(e.target.checked);
    });

    systemPrefersDark.addEventListener('change', (e) => {
        if (!localStorage.getItem('theme')) {
            updateThemeUI(e.matches);
        }
    });

    applyTheme();

    function toggleOptions() {
        const type = downloadTypeSelect.value;
        audioOptions.style.display = (type === 'audio') ? 'block' : 'none';
        videoOptions.style.display = (type === 'video') ? 'grid' : 'none';
        videoFormatOption.style.display = (type === 'video') ? 'block' : 'none';
    }

    function checkWavWarning() {
        wavWarning.style.display = (audioFormatSelect.value === 'wav') ? 'block' : 'none';
    }

    downloadTypeSelect.addEventListener('change', toggleOptions);
    audioFormatSelect.addEventListener('change', checkWavWarning);
    toggleOptions();
    checkWavWarning();

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const downloadType = downloadTypeSelect.value;
        const payload = {
            mediaUrl: document.getElementById('mediaUrl').value,
            format: downloadType === 'audio' ? document.getElementById('audioFormat').value : document.getElementById('videoFormat').value,
            resolution: document.getElementById('resolution').value,
            highest_fps: document.getElementById('highest_fps').value,
            includeSubtitles: document.getElementById('includeSubtitles').checked,
        };

        if (!payload.mediaUrl) {
            alert("Please enter a URL.");
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Downloading...';
        statusDiv.style.display = 'none';
        statusDiv.textContent = '';

        try {
            const resp = await fetch('/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!resp.ok) {
                const errorData = await resp.json().catch(() => ({ error: 'An unknown server error occurred.' }));
                throw new Error(errorData.error || 'Failed to start download.');
            }

            const data = await resp.json();

            if (data.downloadUrl) {
                statusDiv.innerHTML = `
                    <p>Your download is ready!</p>
                    <a href="${data.downloadUrl}" download>Download File</a>
                    <p><b>For iOS users:</b> Tap the download link. Once the "Do you want to download" opens tap the "Download" button to download the Video/Audio file to your device.</p>
                `;
                statusDiv.style.display = 'block';
            } else {
                throw new Error('Server did not provide a download link.');
            }

        } catch (err) {
            statusDiv.textContent = `Error: ${err.message}`;
            statusDiv.style.display = 'block';
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Start Download';
        }
    });
});