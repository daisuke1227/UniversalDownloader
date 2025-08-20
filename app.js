require('dotenv').config();

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const archiver = require('archiver');
const sanitize = require('sanitize-filename');

const PORT = process.env.PORT || 3000;
const DOWNLOAD_ROOT = path.resolve(__dirname, process.env.DOWNLOAD_ROOT);
const UPLOAD_ROOT = path.resolve(__dirname, process.env.UPLOAD_ROOT);
const YOUTUBE_COOKIES_PATH = path.resolve(__dirname, process.env.YOUTUBE_COOKIES_PATH);
const VIMEO_COOKIES_PATH = path.resolve(__dirname, process.env.VIMEO_COOKIES_PATH);

const JOB_TTL_MS = (parseFloat(process.env.JOB_TTL_HOURS) || 3) * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = (parseFloat(process.env.CLEANUP_INTERVAL_HOURS) || 3) * 60 * 60 * 1000;

if (!fs.existsSync(DOWNLOAD_ROOT)) {
    fs.mkdirSync(DOWNLOAD_ROOT, { recursive: true });
}
if (!fs.existsSync(UPLOAD_ROOT)) {
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

const app = express();
const jobs = {};
const upload = multer({ dest: UPLOAD_ROOT });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/info', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'info.html'));
});
app.get('/credits', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'credits.html'));
});

const getCookiesArgs = (url) => {
    const isVimeo = /vimeo/i.test(url);
    const cookiesPath = isVimeo ? VIMEO_COOKIES_PATH : YOUTUBE_COOKIES_PATH;
    return fs.existsSync(cookiesPath) ? ['--cookies', cookiesPath] : [];
};

const cleanupOldFiles = async () => {
    const now = Date.now();
    for (const dir of [DOWNLOAD_ROOT, UPLOAD_ROOT]) {
        try {
            const files = await fs.promises.readdir(dir);
            for (const file of files) {
                const filePath = path.join(dir, file);
                const stats = await fs.promises.stat(filePath);
                if (now - stats.mtime.getTime() > JOB_TTL_MS) {
                    await fs.promises.rm(filePath, { recursive: true, force: true });
                }
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error(`Cleanup failed for ${dir}:`, err);
            }
        }
    }
};

const zipDirectory = async (sourceDir, outPath) => {
    const outputPath = path.join(DOWNLOAD_ROOT, outPath);
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    return new Promise((resolve, reject) => {
        output.on('close', () => resolve(outputPath));
        archive.on('error', (err) => reject(err));
        archive.pipe(output);
        archive.glob('**/*', { cwd: sourceDir });
        archive.finalize();
    });
};

const runYtdlp = (args) => {
    return new Promise((resolve, reject) => {
        console.log(`Executing download command: yt-dlp ${args.join(' ')}`);
        const ytdlp = spawn('yt-dlp', args);
        let stderr = '';
        ytdlp.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        ytdlp.stdout.on('data', (data) => {
            console.log(data.toString());
        });
        ytdlp.on('error', (err) => reject(err));
        ytdlp.on('close', (code) => {
            if (code !== 0) {
                if (stderr.includes('403')) {
                    return reject(new Error('A temporary error (403 Forbidden) occurred. Please try the download again.'));
                }
                reject(new Error(`yt-dlp exited with code ${code}. Stderr: ${stderr.trim()}`));
            } else {
                resolve();
            }
        });
    });
};

const downloadWithCurl = (job, url, outputPath) => {
    return new Promise((resolve, reject) => {
        const args = ['-L', url, '-o', outputPath, '--progress-bar'];
        console.log(`[JOB ${job.id}] Executing download command: curl ${args.join(' ')}`);
        const curl = spawn('curl', args);
        curl.on('error', (err) => reject(err));
        curl.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`Download process exited with code ${code}`));
            }
            resolve(outputPath);
        });
    });
};

const downloadSingleItem = async (job, url, options, outTemplate, title = '') => {
    const { format, resolution, highest_fps, includeSubtitles } = options;
    const isVideo = format === 'mp4';
    const resInt = resolution ? parseInt(resolution, 10) : null;
    let formatString = '';

    const isFacebook = /facebook\.com/i.test(url);
    const isNewgrounds = /newgrounds\.com/i.test(url);
    const isSnapchatCdn = /sc-cdn\.net/i.test(url);
    const isTumblr = /tumblr\.com/i.test(url);

    if (isFacebook || isNewgrounds || isSnapchatCdn || isTumblr) {
        formatString = 'best';
    } else if (isVideo) {
        const heightFilter = resInt ? `[height<=${resInt}]` : '';
        const fpsFilter = highest_fps === 'no' ? '[fps<=30]' : '';
        formatString = `bestvideo[vcodec^=avc]${heightFilter}${fpsFilter}+bestaudio[ext=m4a]/best[ext=mp4]${heightFilter}${fpsFilter}/best`;
    } else {
        formatString = 'bestaudio/best';
    }

    const subtitleArgs = includeSubtitles ? ['--write-auto-subs', '--write-subs', '--embed-subs', '--sub-langs', 'en.*', '--convert-subs', 'srt'] : [];
    
    const emojiRegex = /\p{Emoji}/u;
    const hasEmoji = title && emojiRegex.test(title);
    let thumbnailArgs = [];

    if (hasEmoji || isTumblr) {
        if (hasEmoji) console.log(`[JOB ${job.id}] Emoji detected in title, skipping thumbnail embedding.`);
        if (isTumblr) console.log(`[JOB ${job.id}] Tumblr URL detected, skipping thumbnail embedding.`);
    } else {
        thumbnailArgs = format !== 'wav' ? ['--write-thumbnail', '--embed-thumbnail', '--convert-thumbnails', 'jpg'] : [];
    }
    
    let audioFormat = format;
    if (format === 'ogg') {
        audioFormat = 'vorbis';
    }

    const args = [
        '--no-playlist',
        '--no-write-comments',
        '--newline',
        '-o', outTemplate,
        '--embed-metadata',
        '--concurrent-fragments', '10',
        ...thumbnailArgs,
        ...subtitleArgs,
        '-f', formatString,
        '--match-filter', "live_status != 'is_live'",
        ...(isVideo ? ['--merge-output-format', 'mp4'] : ['-x', '--audio-format', audioFormat, '--audio-quality', '0']),
        ...getCookiesArgs(url),
        url,
    ];

    await runYtdlp(args);

    const dir = path.dirname(outTemplate);
    const filesInDir = await fs.promises.readdir(dir);
    const mediaFile = filesInDir.find((f) => ['.m4a', '.mp3', '.mp4', '.mkv', '.webm', '.opus', '.ogg', '.flac', '.wav'].some((ext) => f.endsWith(ext)));
    if (!mediaFile) {
        throw new Error('Could not locate downloaded media file.');
    }
    return path.join(dir, mediaFile);
};

const handlePlaylistDownload = async (job, url, entries, playlistTitle, options) => {
    const randomString = uuidv4().slice(0, 16);
    const sanitizedTitle = sanitize(`${playlistTitle || 'playlist'}-${randomString}`);
    const playlistDir = path.join(DOWNLOAD_ROOT, sanitizedTitle);
    await fs.promises.mkdir(playlistDir, { recursive: true });
    job.playlistTempDir = playlistDir;

    const { format, resolution, highest_fps, includeSubtitles } = options;
    const isVideo = format === 'mp4';
    const resInt = resolution ? parseInt(resolution, 10) : null;
    let formatString = '';
    const isTumblr = /tumblr\.com/i.test(url);

    if (isTumblr) {
        formatString = 'best';
    } else if (isVideo) {
        const heightFilter = resInt ? `[height<=${resInt}]` : '';
        const fpsFilter = highest_fps === 'no' ? '[fps<=30]' : '';
        formatString = `bestvideo[vcodec^=avc]${heightFilter}${fpsFilter}+bestaudio[ext=m4a]/best[ext=mp4]${heightFilter}${fpsFilter}/best`;
    } else {
        formatString = 'bestaudio/best';
    }

    const subtitleArgs = includeSubtitles ? ['--write-auto-subs', '--write-subs', '--embed-subs', '--sub-langs', 'en.*', '--convert-subs', 'srt'] : [];
    let thumbnailArgs = [];
    if (!isTumblr) {
       thumbnailArgs = format !== 'wav' ? ['--write-thumbnail', '--embed-thumbnail', '--convert-thumbnails', 'jpg'] : [];
    }

    const outTemplate = path.join(playlistDir, `%(uploader,channel)s - %(title)s.%(ext)s`);
    let audioFormat = format;
    if (format === 'ogg') {
        audioFormat = 'vorbis';
    }

    const sleepArgs = entries.length > 50 ? ['--sleep-interval', '5', '--max-sleep-interval', '10'] : [];
    const args = [
        '--no-playlist',
        '--no-write-comments',
        '-o', outTemplate,
        '--embed-metadata',
        '--newline',
        '--concurrent-fragments', '10',
        ...sleepArgs,
        ...thumbnailArgs,
        ...subtitleArgs,
        '-f', formatString,
        '--match-filter', "live_status != 'is_live'",
        ...(isVideo ? ['--merge-output-format', 'mp4'] : ['-x', '--audio-format', audioFormat, '--audio-quality', '0']),
        ...getCookiesArgs(url),
        ...entries.map(entry => entry.url),
    ];

    await runYtdlp(args);

    if (entries.length > 1) {
        job.filePath = await zipDirectory(playlistDir, `${sanitizedTitle}.zip`);
    } else {
        const files = await fs.promises.readdir(playlistDir);
        if (files.length > 0) {
            job.filePath = path.join(playlistDir, files[0]);
        } else {
            throw new Error('Could not find downloaded file in playlist directory.');
        }
    }
};

const handleSingleDownload = async (job, metadata, options) => {
    const randomString = uuidv4().slice(0, 16);
    const sanitizedTitle = sanitize(`${metadata.title || 'download'}-${randomString}`);
    const singleDir = path.join(DOWNLOAD_ROOT, sanitizedTitle);
    await fs.promises.mkdir(singleDir, { recursive: true });
    job.playlistTempDir = singleDir;
    const outTemplate = path.join(singleDir, `%(uploader,channel)s - %(title)s.%(ext)s`);
    const url = metadata.webpage_url || metadata.url;
    job.filePath = await downloadSingleItem(job, url, options, outTemplate, metadata.title);
};

const getFacebookTitleAndUploader = (job, url) => {
    return new Promise((resolve, reject) => {
        const args = ['--get-title', ...getCookiesArgs(url), url];
        const proc = spawn('yt-dlp', args);
        let titleData = '';
        let errorData = '';
        proc.stdout.on('data', chunk => titleData += chunk);
        proc.stderr.on('data', chunk => errorData += chunk);
        proc.on('error', err => reject(err));
        proc.on('close', code => {
            if (code !== 0) {
                return reject(new Error('Could not fetch title for Facebook video.'));
            }
            const messyTitle = titleData.trim();
            const parts = messyTitle.split('｜').map(p => p.trim());
            let finalTitle = `Facebook-Video-${uuidv4().slice(0, 8)}`;
            let finalUploader = 'Unknown Uploader';
            if (parts.length >= 2) {
                finalUploader = parts[parts.length - 1];
                finalTitle = parts[parts.length - 2];
            } else if (messyTitle) {
                finalTitle = messyTitle;
            }
            resolve({ title: finalTitle, uploader: finalUploader });
        });
    });
};

const getSnapchatDirectUrl = (job, url) => {
    return new Promise((resolve, reject) => {
        const proc = spawn('curl', ['-L', url]);
        let htmlData = '';
        let errorData = '';
        proc.stdout.on('data', chunk => htmlData += chunk);
        proc.stderr.on('data', chunk => errorData += chunk);
        proc.on('error', err => reject(err));
        proc.on('close', code => {
            if (code !== 0) {
                return reject(new Error('Failed to fetch Snapchat page content.'));
            }
            const regex = /<link[^>]+rel="preload"[^>]+href="([^"]+)"[^>]+as="video"/;
            const match = htmlData.match(regex);
            if (match && match[1]) {
                const directUrl = match[1].replace(/&amp;/g, '&');
                resolve(directUrl);
            } else {
                reject(new Error('Could not find direct video link in Snapchat page.'));
            }
        });
    });
};

const getAllVideoEntries = async (initialUrl) => {
    const allVideoEntries = [];
    const playlistsToProcess = [initialUrl];
    const processedUrls = new Set();
    let originalMetadata = null;
    const processEntries = (entries) => {
        for (const entry of entries) {
            if (entry._type === 'playlist' && entry.entries) {
                processEntries(entry.entries);
            } else if (entry._type === 'url_transparent' && entry.url) {
                if (!processedUrls.has(entry.url)) playlistsToProcess.push(entry.url);
            } else if (entry.url) {
                allVideoEntries.push(entry);
            }
        }
    };
    while (playlistsToProcess.length > 0) {
        const currentUrl = playlistsToProcess.shift();
        if (processedUrls.has(currentUrl)) continue;
        processedUrls.add(currentUrl);
        const args = ['--dump-single-json', '--flat-playlist', '--match-filter', "live_status != 'is_live'", currentUrl, ...getCookiesArgs(currentUrl)];
        const proc = spawn('yt-dlp', args);
        let jsonData = '';
        let errorData = '';
        proc.stdout.on('data', (chunk) => jsonData += chunk);
        proc.stderr.on('data', (chunk) => errorData += chunk);
        await new Promise((resolve, reject) => {
            proc.on('error', (err) => reject(err));
            proc.on('close', (code) => {
                if (code !== 0) {
                    const detailedError = `Metadata fetch for ${currentUrl} failed. Stderr: ${errorData.trim()}`;
                    reject(new Error(detailedError));
                } else {
                    resolve();
                }
            });
        });
        try {
            const metadata = JSON.parse(jsonData);
            if (!originalMetadata) originalMetadata = metadata;
            if (metadata.entries) {
                processEntries(metadata.entries);
            } else if (metadata.url || metadata.webpage_url) {
                allVideoEntries.push(metadata);
            }
        } catch (e) {
            console.warn(`Warning: Could not parse metadata from ${currentUrl}.`);
        }
    }
    const seenIds = new Set();
    const uniqueEntries = allVideoEntries.filter((entry) => {
        if (!entry.id || seenIds.has(entry.id)) return false;
        seenIds.add(entry.id);
        return true;
    });
    return {
        entries: uniqueEntries,
        originalMetadata: originalMetadata || { title: `Content from ${initialUrl}`, _type: 'playlist' },
    };
};

app.post('/download', async (req, res) => {
    const rawInput = req.body.mediaUrl;
    if (!rawInput) {
        return res.status(400).json({ error: 'Missing mediaUrl' });
    }
    const urlMatch = rawInput.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
        return res.status(400).json({ error: 'No valid URL found in the provided text.' });
    }
    const mediaUrl = urlMatch[0];
    
    const jobId = uuidv4();
    jobs[jobId] = { id: jobId, filePath: null, playlistTempDir: null };
    const job = jobs[jobId];

    try {
        const isSnapchat = /snapchat\.com/i.test(mediaUrl);
        const isFacebook = /facebook\.com/i.test(mediaUrl);

        if (isSnapchat) {
            const directUrl = await getSnapchatDirectUrl(job, mediaUrl);
            const sanitizedTitle = sanitize('Snapchat - Spotlight Video');
            const jobDir = path.join(DOWNLOAD_ROOT, `${sanitizedTitle}-${uuidv4().slice(0,8)}`);
            await fs.promises.mkdir(jobDir, { recursive: true });
            job.playlistTempDir = jobDir;
            const outputPath = path.join(jobDir, `${sanitizedTitle}.mp4`);
            job.filePath = await downloadWithCurl(job, directUrl, outputPath);
        } else if (isFacebook) {
            const { title, uploader } = await getFacebookTitleAndUploader(job, mediaUrl);
            const mockMetadata = { title: `${uploader} - ${title}`, webpage_url: mediaUrl };
            await handleSingleDownload(job, mockMetadata, req.body);
        } else {
            const { entries, originalMetadata } = await getAllVideoEntries(mediaUrl);
            if (!entries || entries.length === 0) {
                throw new Error('No downloadable videos found.');
            }
            if (entries.length === 1 && originalMetadata._type !== 'playlist') {
                await handleSingleDownload(job, entries[0], req.body);
            } else {
                await handlePlaylistDownload(job, mediaUrl, entries, originalMetadata.title, req.body);
            }
        }

        res.json({ downloadUrl: `/file/${job.id}` });

    } catch (err) {
        console.error(`[JOB ${jobId}] Error:`, err);
        delete jobs[jobId];
        res.status(500).json({ error: err.message.toString() || 'Unknown error' });
    } finally {
        setTimeout(() => {
            const finishedJob = jobs[jobId];
            if (finishedJob?.playlistTempDir) {
                fs.promises.rm(finishedJob.playlistTempDir, { recursive: true, force: true }).catch(() => {});
            }
            delete jobs[jobId];
        }, JOB_TTL_MS);
    }
});

app.get('/file/:jobId', (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job?.filePath || !fs.existsSync(job.filePath)) {
        return res.status(404).send('File not found or job has expired.');
    }
    res.download(job.filePath, path.basename(job.filePath), async (err) => {
        if (!err) {
            if (fs.existsSync(job.filePath)) {
                await fs.promises.unlink(job.filePath);
            }
            if (job.playlistTempDir && fs.existsSync(job.playlistTempDir)) {
                await fs.promises.rm(job.playlistTempDir, { recursive: true, force: true });
            }
        }
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    cleanupOldFiles().catch((err) => console.error('Startup cleanup failed:', err));
    setInterval(() => cleanupOldFiles().catch((err) => console.error('Periodic cleanup failed:', err)), CLEANUP_INTERVAL_MS);
});