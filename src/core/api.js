import cors from "cors";
import rateLimit from "express-rate-limit";
import { randomBytes } from "crypto";

const ipSalt = randomBytes(64).toString('hex');

import { version } from "../modules/config.js";
import { getJSON } from "../modules/api.js";
import { apiJSON, checkJSONPost, getIP, languageCode } from "../modules/sub/utils.js";
import { Bright, Cyan } from "../modules/sub/consoleText.js";
import stream from "../modules/stream/stream.js";
import loc from "../localization/manager.js";
import { sha256 } from "../modules/sub/crypto.js";
import { verifyStream } from "../modules/stream/manage.js";
import { downloadVideo } from "../modules/stream/types.js";
import { request } from "../modules/processing/services/instagram.js";
import { bestQuality } from "../modules/processing/services/twitter.js";

export function runAPI(express, app, gitCommit, gitBranch, __dirname) {
    const corsConfig = process.env.cors === '0' ? {
        origin: process.env.webURL,
        optionsSuccessStatus: 200
    } : {};

    const apiLimiter = rateLimit({
        windowMs: 60000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req, res) => sha256(getIP(req), ipSalt),
        handler: (req, res, next, opt) => {
            return res.status(429).json({
                "status": "rate-limit",
                "text": loc(languageCode(req), 'ErrorRateLimit')
            });
        }
    });
    const apiLimiterStream = rateLimit({
        windowMs: 60000,
        max: 25,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req, res) => sha256(getIP(req), ipSalt),
        handler: (req, res, next, opt) => {
            return res.status(429).json({
                "status": "rate-limit",
                "text": loc(languageCode(req), 'ErrorRateLimit')
            });
        }
    });
    
    const startTime = new Date();
    const startTimestamp = Math.floor(startTime.getTime());

    app.use('/api/:type', cors(corsConfig));
    app.use('/api/json', apiLimiter);
    app.use('/api/pool', apiLimiter);
    app.use('/api/instagram', apiLimiter);
    app.use('/api/twitter', apiLimiter);
    app.use('/api/stream', apiLimiterStream);
    app.use('/api/download', apiLimiterStream);
    app.use('/api/onDemand', apiLimiter);

    app.use((req, res, next) => {
        try { decodeURIComponent(req.path) } catch (e) { return res.redirect('/') }
        next();
    });
    app.use('/api/json', express.json({
        verify: (req, res, buf) => {
            let acceptCon = String(req.header('Accept')) === "application/json";
            if (acceptCon) {
                if (buf.length > 720) throw new Error();
                JSON.parse(buf);
            } else {
                throw new Error();
            }
        }
    }));
    // handle express.json errors properly (https://github.com/expressjs/express/issues/4065)
    app.use('/api/json', (err, req, res, next) => {
        let errorText = "invalid json body";
        let acceptCon = String(req.header('Accept')) !== "application/json";

        if (err || acceptCon) {
            if (acceptCon) errorText = "invalid accept header";
            return res.status(400).json({
                status: "error",
                text: errorText
            });
        } else {
            next();
        }
    });
    app.post('/api/json', async (req, res) => {
        try {
            let lang = languageCode(req);
            let j = apiJSON(0, { t: "bad request" });
            try {
                let contentCon = String(req.header('Content-Type')) === "application/json";
                let request = req.body;
                if (contentCon && request.url) {
                    request.dubLang = request.dubLang ? lang : false;
    
                    let chck = checkJSONPost(request);
                    if (!chck) throw new Error();
    
                    j = await getJSON(chck["url"], lang, chck);
                } else {
                    j = apiJSON(0, {
                        t: !contentCon ? "invalid content type header" : loc(lang, 'ErrorNoLink')
                    });
                }
            } catch (e) {
                j = apiJSON(0, { t: loc(lang, 'ErrorCantProcess') });
            }
            return res.status(j.status).json(j.body);
        } catch (e) {
            return res.destroy();
        }
    });

    app.get('/api/download', async (req, res) => {
        const url = req.query.url;
        const filename = req.query.filename;

        try {
            if (url && filename) {
                return downloadVideo({ url, filename }, res);
            }
        } catch (e) {
            res.status(500).json({ status: "error", text: "Internal Server Error" });
        }
    });

    app.get('/api/instagram', async (req, res) => {
        const postId = req.query.postId;

        let data;
        try {
            const cookie = undefined;

            const url = new URL('https://www.instagram.com/graphql/query/');
            url.searchParams.set('query_hash', 'b3055c01b4b222b8a47dc12b090e4e64')
            url.searchParams.set('variables', JSON.stringify({
                child_comment_count: 3,
                fetch_comment_count: 40,
                has_threaded_comments: true,
                parent_comment_count: 24,
                shortcode: postId
            }))

            data = (await request(url, cookie)).data;
        } catch { }

        if (!data) return res.status(500).json({ data: 'ErrorEmptyDownload' });

        const sidecar = data?.shortcode_media?.edge_sidecar_to_children;
        if (sidecar) {
            let picker = sidecar.edges.filter(e => e.node?.display_url)
            .map(e => {
                const type = e.node?.is_video ? "video" : "photo";
                const url = type === "video" ? e.node?.video_url : e.node?.display_url;

                return {
                    type,
                    thumb: `/tools/api/stream?url=${encodeURIComponent(e.node?.display_url)}&filename=image.jpg`,
                    resolutions: [{ url, quality: 'best' }]
                }
            });

            if (picker.length) {
            return res.status(200).json({
                type: 'success',
                text: `Instagram - #${postId}`,
                id: postId,
                data: picker
            });
            }
        } else if (data?.shortcode_media?.video_url) {
            return res.status(200).json({
                type: 'success',
                text: `Instagram - #${postId}`,
                id: postId,
                data: [{
                    type: 'video',
                    thumb: `/tools/api/stream?url=${encodeURIComponent(data.shortcode_media?.display_url)}&filename=image.jpg`,
                    resolutions: [{ url: data.shortcode_media.video_url, quality: 'best' }]
                }]
            });
        } else if (data?.shortcode_media?.display_url) {
            return res.status(200).json({
                type: 'success',
                text: `Instagram - #${postId}`,
                id: postId,
                data: [{
                    type: 'photo',
                    thumb: `/tools/api/stream?url=${encodeURIComponent(data.shortcode_media?.display_url)}&filename=image.jpg`,
                    resolutions: [{ url: data.shortcode_media.display_url, quality: 'best' }]
                }]
            });
        }
    });

    app.get('/api/twitter', async (req, res) => {
        const id = req.query.id;
        let _headers = {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
          "authorization": "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
          "host": "api.twitter.com",
          "x-twitter-client-language": "en",
          "x-twitter-active-user": "yes",
          "accept-language": "en"
        };
      
        let activateURL = `https://api.twitter.com/1.1/guest/activate.json`;
        let graphqlTweetURL = `https://twitter.com/i/api/graphql/5GOHgZe-8U2j5sVHQzEm9A/TweetResultByRestId`;
      
        let req_act = await fetch(activateURL, {
          method: "POST",
          next: { revalidate: 0 },
          headers: _headers
        }).then((r) => { return r.status === 200 ? r.json() : false }).catch(() => { return false });
      
        if (!req_act) return res.status(200).json({ type: 'error', data: 'Tidak dapat mengambil data dari link ini. Pastikan link twitter yang kamu berikan dapat di akses.' });
      
        _headers["host"] = "twitter.com";
        _headers["content-type"] = "application/json";
      
        _headers["x-guest-token"] = req_act["guest_token"];
        _headers["cookie"] = `guest_id=v1%3A${req_act["guest_token"]}`;
      
        let query = {
          variables: { "tweetId": id, "withCommunity": false, "includePromotedContent": false, "withVoice": false },
          features: { "creator_subscriptions_tweet_preview_api_enabled": true, "c9s_tweet_anatomy_moderator_badge_enabled": true, "tweetypie_unmention_optimization_enabled": true, "responsive_web_edit_tweet_api_enabled": true, "graphql_is_translatable_rweb_tweet_is_translatable_enabled": true, "view_counts_everywhere_api_enabled": true, "longform_notetweets_consumption_enabled": true, "responsive_web_twitter_article_tweet_consumption_enabled": false, "tweet_awards_web_tipping_enabled": false, "responsive_web_home_pinned_timelines_enabled": true, "freedom_of_speech_not_reach_fetch_enabled": true, "standardized_nudges_misinfo": true, "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": true, "longform_notetweets_rich_text_read_enabled": true, "longform_notetweets_inline_media_enabled": true, "responsive_web_graphql_exclude_directive_enabled": true, "verified_phone_label_enabled": false, "responsive_web_media_download_video_enabled": false, "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false, "responsive_web_graphql_timeline_navigation_enabled": true, "responsive_web_enhance_cards_enabled": false }
        }
        query.variables = encodeURIComponent(JSON.stringify(query.variables));
        query.features = encodeURIComponent(JSON.stringify(query.features));
        query = `${graphqlTweetURL}?variables=${query.variables}&features=${query.features}`;
      
        let tweet = await fetch(query, { headers: _headers }).then((r) => {
          return r.status === 200 ? r.json() : false
        }).catch((e) => { return false });
      
        if (tweet?.data?.tweetResult?.result?.__typename !== "Tweet") {
          return res.status(200).json({ type: 'error', data: 'Tweet tidak tersedia.' });
        }
      
        let baseMedia,
          baseTweet = tweet.data.tweetResult.result.legacy;
      
        if (baseTweet.retweeted_status_result?.result.legacy.extended_entities.media) {
          baseMedia = baseTweet.retweeted_status_result.result.legacy.extended_entities;
        } else if (baseTweet.extended_entities?.media) {
          baseMedia = baseTweet.extended_entities;
        } else if (tweet.data.tweetResult.result.quoted_status_result.result.legacy.extended_entities) {
          baseMedia = tweet.data.tweetResult.result.quoted_status_result.result.legacy.extended_entities;
        }
      
        if (!baseMedia) return res.status(200).json({ type: 'error', data: 'Tidak menemukan video dalam tweet ini.' });
      
        let single, multiple = [], media = baseMedia["media"];
        media = media.filter((i) => { if (i["type"] === "video" || i["type"] === "animated_gif") return true });
      
        if (media.length > 1) {
          for (let i in media) {
            multiple.push({
              type: media[i]["type"],
              thumb: `/tools/api/stream?url=${encodeURIComponent(media[i]["media_url_https"])}&filename=image.jpg`,
              duration: media[i]["video_info"]["duration_millis"],
              resolutions: [{ url: bestQuality(media[i]["video_info"]["variants"]), quality: 'best' }]
            })
          }
        } else if (media.length === 1) {
          single = bestQuality(media[0]["video_info"]["variants"])
        } else {
          return res.status(200).json({ type: 'error', data: 'Tidak menemukan video dalam tweet ini.' });
        }

        if (single) {
          return res.status(200).json({
            type: 'success',
            text: baseTweet.full_text,
            id,
            data: [{
              type: media[0]["type"],
              thumb: `/tools/api/stream?url=${encodeURIComponent(media[0]['media_url_https'])}&filename=image.jpg`,
              duration: media[0]["video_info"]["duration_millis"],
              resolutions: [{ url: single, quality: 'best' }]
            }]
          });
        } else if (multiple) {
          return res.status(200).json({
            type: 'success',
            id,
            text: baseTweet.full_text,
            data: multiple
          });
        } else {
          return res.status(200).json({ type: 'error', data: 'Tidak menemukan video dalam tweet ini.' });
        }
    });

    app.get('/api/:type', (req, res) => {
        try {
            switch (req.params.type) {
                case 'pool': 
                    if (req.query.bid && req.query.filename) {
                        return stream(res, { type: 'pool', bid: req.query.bid, filename: req.query.filename }, req);
                    }
                case 'stream':
                    if (req.query.t && req.query.h && req.query.e && req.query.t.toString().length === 21
                    && req.query.h.toString().length === 64 && req.query.e.toString().length === 13) {
                        let streamInfo = verifyStream(req.query.t, req.query.h, req.query.e);
                        if (streamInfo.error) {
                            return res.status(streamInfo.status).json(apiJSON(0, { t: streamInfo.error }).body);
                        }
                        if (req.query.p) {
                            return res.status(200).json({
                                status: "continue"
                            });
                        }
                        return stream(res, streamInfo, req);
                    } else {
                        let j = apiJSON(0, {
                            t: "stream token, hmac, or expiry timestamp is missing"
                        })
                        return res.status(j.status).json(j.body);
                    }
                case 'serverInfo':
                    return res.status(200).json({
                        version: version,
                        commit: gitCommit,
                        branch: gitBranch,
                        name: process.env.apiName ? process.env.apiName : "unknown",
                        url: process.env.apiURL,
                        cors: process.env.cors && process.env.cors === "0" ? 0 : 1,
                        startTime: `${startTimestamp}`
                    });
                default:
                    let j = apiJSON(0, {
                        t: "unknown response type"
                    })
                    return res.status(j.status).json(j.body);
            }
        } catch (e) {
            return res.status(500).json({
                status: "error",
                text: loc(languageCode(req), 'ErrorCantProcess')
            });
        }
    });
    app.get('/api/status', (req, res) => {
        res.status(200).end()
    });
    app.get('/favicon.ico', (req, res) => {
        res.sendFile(`${__dirname}/src/front/icons/favicon.ico`)
    });
    app.get('/*', (req, res) => {
        res.redirect('/api/json')
    });

    app.listen(process.env.apiPort, () => {
        console.log(`\n` +
            `${Cyan("cobalt")} API ${Bright(`v.${version}-${gitCommit} (${gitBranch})`)}\n` +
            `Start time: ${Bright(`${startTime.toUTCString()} (${startTimestamp})`)}\n\n` +
            `URL: ${Cyan(`${process.env.apiURL}`)}\n` +
            `Port: ${process.env.apiPort}\n`
        )
    });
}
