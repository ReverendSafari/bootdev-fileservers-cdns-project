import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";
import { randomBytes } from "crypto";


type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};




export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  const MAX_UPLOAD_SIZE = 10 << 20;

  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const thumbnail = formData.get("thumbnail");

  if (!(thumbnail instanceof File)) {
    throw new BadRequestError("Thumbnail not a file");
  }

  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Error file too large, must be under 10MB");
  }

  const mediaType = thumbnail.type;

  if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
    throw new BadRequestError("Invalid file type");
  }

  const fileExtension = `.${mediaType.split('/')[1]}`;
  const arrayBuffer = await thumbnail.arrayBuffer();
  const randomVideoIdString = randomBytes(32).toString('base64url');
  const filePath = path.join(cfg.assetsRoot, randomVideoIdString + fileExtension);

  Bun.write(filePath, arrayBuffer);
  const video = getVideo(cfg.db, videoId);

  if (video?.userID != userID) {
    throw new UserForbiddenError("UserID does not match UserID of video");
  }

  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${randomVideoIdString}${fileExtension}`;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
