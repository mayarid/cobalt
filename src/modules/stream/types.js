import { spawn } from "child_process";
import ffmpeg from "ffmpeg-static";
import { ffmpegArgs, genericUserAgent } from "../config.js";
import { getThreads, metadataManager } from "../sub/utils.js";
import { request } from "undici";
import { create as contentDisposition } from "content-disposition-header";
import { AbortController } from "abort-controller"
import { access, constants, createReadStream, unlink } from "fs";
import { createHash, randomBytes } from "crypto";
import path from "path";

const ongoingProcesses = new Map();
const ongoingSpawn = new Map();

function closeRequest(controller) {
  try { controller.abort() } catch {}
}

function closeResponse(res) {
  if (!res.headersSent) res.sendStatus(500);
  return res.destroy();
}

function killProcess(p) {
  // ask the process to terminate itself gracefully
  p?.kill('SIGTERM');
  setTimeout(() => {
    if (p?.exitCode === null)
      // brutally murder the process if it didn't quit
      p?.kill('SIGKILL');
  }, 5000);
}

function pipe(from, to, done) {
  from.on('error', done)
    .on('close', done);

  to.on('error', done)
    .on('close', done);

  from.pipe(to);
}

export async function downloadVideo(info, res) {
  const abortController = new AbortController();
  const shutdown = () => {
    console.log('response close, and done')
    closeRequest(abortController);
    closeResponse(res);
  };

  try {
    res.setHeader('Content-disposition', contentDisposition(info.filename));

    const { body: stream, headers } = await request(info.url, {
      headers: { 'user-agent': genericUserAgent },
      signal: abortController.signal,
      maxRedirections: 16
    });

    res.setHeader('Connection', 'keep-alive');
    res.setHeader('content-type', headers['content-type']);
    res.setHeader('content-length', headers['content-length']);

    pipe(stream, res, shutdown);
  } catch {
    shutdown();
  }
}

export async function streamDefault(streamInfo, res) {
  const abortController = new AbortController();
  const shutdown = () => (closeRequest(abortController), closeResponse(res));

  try {
    const filename = streamInfo.isAudioOnly ? `${streamInfo.filename}.${streamInfo.audioFormat}` : streamInfo.filename;
    res.setHeader('Content-disposition', contentDisposition(filename));

    const { body: stream, headers } = await request(streamInfo.urls, {
      headers: { 'user-agent': genericUserAgent },
      signal: abortController.signal,
      maxRedirections: 16
    });

    res.setHeader('content-type', headers['content-type']);
    res.setHeader('content-length', headers['content-length']);

    pipe(stream, res, shutdown);
  } catch {
    shutdown();
  }
}

function isBidHex (bid) {
  const hexRegex = /^[0-9a-fA-F]+$/;
  return hexRegex.test(bid);
}

function validateFilePath(filePath) {
  const basePath = path.resolve('./tmp'); // Set your base directory
  const resolvedPath = path.resolve(basePath, filePath);

  // Check if the resolved path is still within the base directory
  if (resolvedPath.startsWith(basePath)) {
    return true;
  } else {
    return false;
  }
}

export async function poolStream(streamInfo, res, req) {
  const bid = streamInfo.bid;

  if (!isBidHex(bid)) {
    res.status(403).json({ error: "Forbidden bid." });
    return;
  }

  const removeFile = (path) => {
    unlink(path, (error) => {
      if (error) {
        console.log(error);
      }
    });
  }

  const outputPath = `./tmp/${bid}.mp4`;

  if (!validateFilePath(outputPath)) {
    res.status(403).json({ error: "Wrong path." });
    return;
  }

  req.on('close', () => {
    if (!res.headersSent) {
      const process = ongoingSpawn.get(bid);
      killProcess(process);
      removeFile(outputPath);
    }
  })
  
  try {
    const inter = setInterval(() => {
      const process = ongoingProcesses.get(bid);
      if (process.status === 'finished') {
        access(outputPath, constants.F_OK, (err) => {
          if (err) {
            console.log('File does not exist.');
          } else {
            const rStream = createReadStream(outputPath);
  
            req.on('close', () => {
              console.log('req close');
              rStream.unpipe(res);
              rStream.destroy();
              closeResponse(res);
            })
  
            rStream.on('error', (err) => {
              console.error(err);
              res.status(500).json({ error: 'Error converting.' });
              removeFile(outputPath);
            });
      
            res.setHeader('Content-Disposition', contentDisposition(streamInfo.filename));
            res.setHeader('Content-Type', 'video/mp4');
      
            rStream.on('end', () => {
              console.log('read stream end, no more data');
            })
      
            rStream.on('close', () => {
              ongoingProcesses.delete(bid);
              console.log('read stream close.');
              removeFile(outputPath);
            });
      
            rStream.pipe(res);
            clearInterval(inter);
          }
        });
      }
    }, 1000);
  
    setTimeout(() => {
      if (!res.headersSent) {
        clearInterval(inter);
        res.status(202).json({ status: 'pending', bid });
      }
    }, 25000);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: 'Internal error' });
  }
}

export async function streamLiveRender(streamInfo, res, req) {
  if (!req) { return res.sendStatus(500) }

  let abortController = new AbortController(), process;
  const shutdown = () => (closeRequest(abortController), killProcess(process), closeResponse(res));
  const removeFile = (path) => {
    unlink(path, (error) => {
      if (error) {
        console.log(error)
      }
    });
  }
  const hashId = createHash('sha256').update(`${randomBytes(25).toString('base64').slice(0, 25)}${streamInfo.filename}`).digest('hex');
  const outputPath = `./tmp/${hashId}.mp4`;
  try {
    if (streamInfo.urls.length !== 2) return shutdown();
    let format = streamInfo.filename.split('.')[streamInfo.filename.split('.').length - 1],
      args = [
        '-loglevel', '-8',
        '-threads', `${getThreads()}`,
        '-i', streamInfo.urls[0],
        '-i', streamInfo.urls[1],
        '-map', '0:v',
        '-map', '1:a',
      ];

    args = args.concat(ffmpegArgs[format]);
    if (streamInfo.metadata) args = args.concat(metadataManager(streamInfo.metadata));
    args.push('-f', format, outputPath);

    process = spawn(ffmpeg, args, {
      windowsHide: true,
      stdio: [
        'inherit', 'inherit', 'inherit',
        'pipe', 'pipe'
      ],
    });
    ongoingSpawn.set(hashId, process);
    ongoingProcesses.set(hashId, { status: 'pending' });

    req.on('close', () => {
      if (!res.headersSent) {
        console.log('request closed stream live');
        shutdown();
      }
    })

    const reqTimeout = setTimeout(() => {
      res.status(202).json({ status: 'pending', bid: hashId });
    }, 25000);

    process.on('error', (err) => {
      ongoingProcesses.delete(hashId);  
      console.error('FFmpeg process error:', err);
      removeFile(outputPath);
    });

    process.on('exit', (code, signal) => {
      if (code !== 0) {
        ongoingProcesses.delete(hashId);
        console.error(`FFmpeg process exited with code ${code} and signal ${signal}`);
        if (!res.headersSent) {
          res.status(500).json({ status: 'error', text: 'process stopped.' });
        }
        removeFile(outputPath);
      } else {
        ongoingProcesses.set(hashId, 'finished');
        console.log('FFmpeg process completed successfully');
      }
    });
    
    process.on('close', () => {
      console.log('process close');

      clearTimeout(reqTimeout);

      if (!res.headersSent) {
        const rStream = createReadStream(outputPath);
        rStream.on('error', () => {
          shutdown();
          res.status(500).json({ error: 'Error converting.' });
          removeFile(outputPath);
        });

        req.on('close', () => {
          rStream.unpipe(res);
          rStream.destroy();
          closeResponse(res);
        })
  
        res.setHeader('Content-Disposition', contentDisposition(streamInfo.filename));
        res.setHeader('Content-Type', 'video/mp4');
  
        rStream.on('end', () => {
          console.log('read stream end, no more data');
        })
  
        rStream.on('close', () => {
          ongoingProcesses.delete(hashId);
          console.log('read stream close.');
          removeFile(outputPath);
        });
  
        rStream.pipe(res);
      } else {
        ongoingProcesses.set(hashId, { status: 'finished' });
      }
    });

  } catch (e) {
    console.error(e);
    shutdown();
    removeFile(outputPath);
  }
}

export function streamAudioOnly(streamInfo, res) {
  let process;
  const shutdown = () => (killProcess(process), closeResponse(res));

  try {
    let args = [
      '-loglevel', '-8',
      '-threads', `${getThreads()}`,
      '-i', streamInfo.urls
    ]

    if (streamInfo.metadata) {
      if (streamInfo.metadata.cover) { // currently corrupts the audio
        args.push('-i', streamInfo.metadata.cover, '-map', '0:a', '-map', '1:0')
      } else {
        args.push('-vn')
      }
      args = args.concat(metadataManager(streamInfo.metadata))
    } else {
      args.push('-vn')
    }

    let arg = streamInfo.copy ? ffmpegArgs["copy"] : ffmpegArgs["audio"];
    args = args.concat(arg);

    if (ffmpegArgs[streamInfo.audioFormat]) args = args.concat(ffmpegArgs[streamInfo.audioFormat]);
    args.push('-f', streamInfo.audioFormat === "m4a" ? "ipod" : streamInfo.audioFormat, 'pipe:3');

    process = spawn(ffmpeg, args, {
      windowsHide: true,
      stdio: [
        'inherit', 'inherit', 'inherit',
        'pipe'
      ],
    });

    const [,,, muxOutput] = process.stdio;

    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Content-Disposition', contentDisposition(`${streamInfo.filename}.${streamInfo.audioFormat}`));

    pipe(muxOutput, res, shutdown);
    res.on('finish', shutdown);
  } catch {
    shutdown();
  }
}

export function streamVideoOnly(streamInfo, res) {
  let process;
  const shutdown = () => (killProcess(process), closeResponse(res));

  try {
    let args = [
      '-loglevel', '-8',
      '-threads', `${getThreads()}`,
      '-i', streamInfo.urls,
      '-c', 'copy'
    ]
    if (streamInfo.mute) args.push('-an');
    if (streamInfo.service === "vimeo" || streamInfo.service === "rutube") args.push('-bsf:a', 'aac_adtstoasc');

    let format = streamInfo.filename.split('.')[streamInfo.filename.split('.').length - 1];
    if (format === "mp4") args.push('-movflags', 'faststart+frag_keyframe+empty_moov');
    args.push('-f', format, 'pipe:3');

    process = spawn(ffmpeg, args, {
      windowsHide: true,
      stdio: [
        'inherit', 'inherit', 'inherit',
        'pipe'
      ],
    });

    const [,,, muxOutput] = process.stdio;

    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Content-Disposition', contentDisposition(streamInfo.filename));

    pipe(muxOutput, res, shutdown);

    process.on('close', shutdown);
    res.on('finish', shutdown);
  } catch {
    shutdown();
  }
}
