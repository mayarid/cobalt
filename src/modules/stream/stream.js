import { poolStream, streamAudioOnly, streamDefault, streamLiveRender, streamVideoOnly } from "./types.js";

export default async function(res, streamInfo, req = null) {
    try {
        if (streamInfo.isAudioOnly && streamInfo.type !== "bridge") {
            streamAudioOnly(streamInfo, res);
            return;
        }
        switch (streamInfo.type) {
            case "pool":
                await poolStream(streamInfo, res, req);
                break;
            case "render":
                await streamLiveRender(streamInfo, res, req);
                break;
            case "videoM3U8":
            case "mute":
                streamVideoOnly(streamInfo, res);
                break;
            default:
                await streamDefault(streamInfo, res);
                break;
        }
    } catch (e) {
        res.status(500).json({ status: "error", text: "Internal Server Error" });
    }
}
