import urlRegexSafe from "url-regex-safe";
import * as fs from "node:fs";
import { exit } from "process";

export const isContentTypeImageType = function (contentType) {
  return contentType.includes("image");
};

// Check url type
// Code is modified based on https://github.com/haorendashu/nostrmo/blob/main/lib/component/content/content_decoder.dart#L505
export const getUrlType = function (path) {
  var strs = path.split("?");
  var index = strs[0].lastIndexOf(".");
  if (index == -1) {
    return "unknown";
  }

  path = strs[0];
  var n = path.substring(index);
  n = n.toLowerCase();

  if (n == ".png" ||
    n == ".jpg" ||
    n == ".jpeg" ||
    n == ".gif" ||
    n == ".webp") {
    return "image";
  } else if (n == ".mp4" || n == ".mov" || n == ".wmv" || n == ".m3u8") {
    return "video";
  } else {
    return "link";
  }
}

export const extractUrl = function (text) {
  const matches = text.match(
    urlRegexSafe({ strict: true, localhost: false, returnString: false })
  );

  return matches;
};

export const cleanUrlWithoutParam = function (url) {
  const newUrl = new URL(url);
  newUrl.search = "";
  return newUrl.toString();
};

export const handleFatalError = function (err) {
  if (typeof err === "undefined") return;
  if (err === null) return;
  console.error(err);
  // force exit
  exit(1);
};

export async function deleteFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.unlink(filePath, (err) => {
      if (err) reject(err);
      resolve(true);
    });
  });
}

export const nMinutesAgo = (n) => Math.floor((Date.now() - n * 60 * 1000) / 1000);

export const truncateString = (text, n) => {
  return (text.length > n) ? text.slice(0, n-1): text;
}