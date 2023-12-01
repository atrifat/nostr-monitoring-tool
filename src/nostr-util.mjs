export const extractHashtags = (tags) => {
  return tags.filter(tag => String(tag[0]) === "t").map(tag => String(tag[1]));
}

export const isActivityPubUser = (tags) => {
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index];
    if (tag.length === 3 && String(tag[0]) === "proxy" && String(tag[2]) === "activitypub") {
      return true;
    }
  }
  return false;
}

export const isRootPost = (tags) => {
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index];
    if (String(tag[0]) === "e") {
      return false;
    }
  }
  return true;
}

export const hasContentWarning = (tags) => {
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index];
    if (String(tag[0]) === "content-warning") {
      return true;
    }
  }
  return false;
}

export const hasNsfwHashtag = (hashtags) => {
  for (let index = 0; index < hashtags.length; index++) {
    const tag = String(hashtags[index]).toLowerCase();
    if (tag === "nsfw") {
      return true;
    }
  }
  return false;
}