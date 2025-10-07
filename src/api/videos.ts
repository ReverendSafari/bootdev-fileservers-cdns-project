import { respondWithJSON } from "./json";
import { randomBytes } from "crypto";
import { type ApiConfig } from "../config";
import { file, S3Client, type BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const videoSizeLimit = 1 << 30;
  const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const params = req.params as { videoId?: string};
  const videoId = params.videoId;

  if (!videoId || !UUID_RE.test(videoId)) {
    throw new BadRequestError("Invalid or Missing video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const videoRecord = getVideo(cfg.db, videoId);

  if (videoRecord?.userID !== userID) {
    throw new UserForbiddenError("Provided user is not owner of video");
  }

  const formData = await req.formData();
  const video = formData.get("video")

  if (!(video instanceof File)) {
    throw new BadRequestError("Video is not a file");
  }

  if (video.size > videoSizeLimit) {
    throw new BadRequestError("Video exceeds upload size limit");
  }

  if (video.type !== "video/mp4") {
    throw new BadRequestError("Invalid file type, not an mp4");
  }

  const fileKey = randomBytes(32).toString('hex');
  const s3Key = `${fileKey}.mp4`;
  const tmpFile = Bun.file(`/tmp/${s3Key}`);

  await Bun.write(`/tmp/${s3Key}`, video);
  
  const aspectRatio = await getVideoAspectRatio(`/tmp/${s3Key}`);
  const fullKey = `${aspectRatio}/${s3Key}`; 
  const processedPath = await processVideoForFastStart(`/tmp/${s3Key}`);
  const processedVideoFile = Bun.file(processedPath);

  const s3File = cfg.s3Client.file(fullKey);
  await s3File.write(processedVideoFile, { type: video.type } );

  videoRecord.videoURL = `${cfg.cloudfrontUrl}${fullKey}`;
  updateVideo(cfg.db, videoRecord);

  await tmpFile.delete();
  await processedVideoFile.delete();

  return respondWithJSON(200, videoRecord);
}

function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number) {
  const presignedUrl = cfg.s3Client.presign(key, {expiresIn: expireTime});
  return presignedUrl;
}



export async function getVideoAspectRatio(filePath: string) {
  const command_arr = ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_streams', `${filePath}`];
  const process = Bun.spawn(command_arr);

  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error("Error while spawning new bun process");
  }
  
  const stdout = await new Response(process.stdout).json();
  const width = stdout.streams[0].width;
  const height = stdout.streams[0].height;

  if (!width || !height) {
    throw new Error("Error extracting video dimensions, object missing fields");
  }

  if (Math.floor(width / 16) == Math.floor(height / 9)) {
    return 'landscape';
  }

  if (Math.floor(width / 9) == Math.floor(height / 16)) {
    return 'portrait';
  }

  return 'other';
}

async function processVideoForFastStart(inputFilePath: string) {
  const outPath = inputFilePath + '.proccessed';
  const command_arr = ['ffmpeg', '-i', `${inputFilePath}`, '-movflags', 'faststart', '-map_metadata', '0', '-codec', 'copy', '-f', 'mp4', `${outPath}`];
  const process = Bun.spawn(command_arr);

  await process.exited;
  return outPath;
}