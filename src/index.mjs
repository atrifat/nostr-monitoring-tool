
import axios from "axios";
import { retry } from "@ultraq/promise-utils";
import to from "await-to-js";
import * as dotenv from 'dotenv';

import 'websocket-polyfill';
import { verifySignature, getPublicKey, getEventHash, getSignature, validateEvent, SimplePool } from 'nostr-tools';
import { RelayPool } from 'nostr';

import { LRUCache } from 'lru-cache';
import {
  extractUrl,
  getUrlType,
  handleFatalError,
  nMinutesAgo,
  truncateString
} from "./util.mjs";

import { extractHashtags, isActivityPubUser, hasContentWarning, hasNsfwHashtag } from "./nostr-util.mjs";
import { isProbablyNSFWContent } from "./classification.mjs";

import fs from "node:fs/promises";

import { connectAsync } from "mqtt";
import { v4 as uuidv4 } from 'uuid';
import pLimit from 'p-limit';
import { exit } from "node:process";

// Load env variable from .env
dotenv.config();
const NODE_ENV = process.env.NODE_ENV || "production";
const ENABLE_NSFW_CLASSIFICATION = process.env.ENABLE_NSFW_CLASSIFICATION ? process.env.ENABLE_NSFW_CLASSIFICATION === 'true' : false;
const NSFW_DETECTOR_ENDPOINT = process.env.NSFW_DETECTOR_ENDPOINT || "";
const NSFW_DETECTOR_TOKEN = process.env.NSFW_DETECTOR_TOKEN || "";
const ENABLE_LANGUAGE_DETECTION = process.env.ENABLE_LANGUAGE_DETECTION ? process.env.ENABLE_LANGUAGE_DETECTION === 'true' : false;
const LANGUAGE_DETECTOR_ENDPOINT = process.env.LANGUAGE_DETECTOR_ENDPOINT || "";
const LANGUAGE_DETECTOR_TOKEN = process.env.LANGUAGE_DETECTOR_TOKEN || "";
const LANGUAGE_DETECTOR_TRUNCATE_LENGTH = parseInt(process.env.LANGUAGE_DETECTOR_TRUNCATE_LENGTH || "350");
if (Number.isNaN(LANGUAGE_DETECTOR_TRUNCATE_LENGTH) || LANGUAGE_DETECTOR_TRUNCATE_LENGTH < 0) {
  handleFatalError(new Error("Invalid LANGUAGE_DETECTOR_TRUNCATE_LENGTH"));
}

const NOSTR_MONITORING_BOT_PRIVATE_KEY = process.env.NOSTR_MONITORING_BOT_PRIVATE_KEY || handleFatalError(new Error("NOSTR_MONITORING_BOT_PRIVATE_KEY is required"));
const RELAYS_SOURCE =
  (typeof process.env.RELAYS_SOURCE !== "undefined" &&
    process.env.RELAYS_SOURCE !== "")
    ? process.env.RELAYS_SOURCE.split(",").map((relay) => relay.trim())
    : [];
const RELAYS_TO_PUBLISH =
  (typeof process.env.RELAYS_TO_PUBLISH !== "undefined" &&
    process.env.RELAYS_TO_PUBLISH !== "")
    ? process.env.RELAYS_TO_PUBLISH.split(",").map((relay) => relay.trim())
    : [];

if (RELAYS_SOURCE.length === 0) handleFatalError(new Error("RELAYS_SOURCE is required"));
if (RELAYS_TO_PUBLISH.length === 0) handleFatalError(new Error("RELAYS_TO_PUBLISH is required"));

const ENABLE_MQTT_PUBLISH = process.env.ENABLE_MQTT_PUBLISH ? process.env.ENABLE_MQTT_PUBLISH === 'true' : false;

const MQTT_BROKER_TO_PUBLISH =
  (typeof process.env.MQTT_BROKER_TO_PUBLISH !== "undefined" &&
    process.env.MQTT_BROKER_TO_PUBLISH !== "")
    ? process.env.MQTT_BROKER_TO_PUBLISH.split(",").map((broker) => broker.trim())
    : [];

if (ENABLE_MQTT_PUBLISH === true && MQTT_BROKER_TO_PUBLISH.length === 0) {
  handleFatalError(new Error("MQTT_BROKER_TO_PUBLISH is required when ENABLE_MQTT_PUBLISH == true"));
}

// Override log and debug functions for production environment. Use console.info, console.warn, console.error instead if needed.
if (NODE_ENV === "production") {
  console.log = (...data) => {

  };
  console.debug = (...data) => {

  };
}

const eventCache = new LRUCache(
  {
    max: 500,
    maxSize: 5000,
    sizeCalculation: (value, key) => {
      return value.toString().length;
    },
    // how long to live in ms
    ttl: 300000,
  }
);

const requestLimiter = pLimit(10);

let mqttBroker = (ENABLE_MQTT_PUBLISH) ? MQTT_BROKER_TO_PUBLISH : [];
let mqttClient = (await Promise.allSettled(mqttBroker.map(url => connectAsync(url))))
  .filter(res => res.status === "fulfilled").map(res => res.value);

let isInRelayPollFunction = false;
let relayPool;

const pool = new SimplePool();

let relays = RELAYS_SOURCE;
let relaysToPublish = RELAYS_TO_PUBLISH;

function axiosRetryStrategy(result, error, attempts) {
  return !!error && attempts < 2 ? attempts * 250 : -1;
}

// Regex for text preprocessing
const MentionNostrEntityRegex = /(nostr:)?@?(nsec1|npub1|nevent1|naddr1|note1|nprofile1|nrelay1)([qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)([\\\\S]*)/gi;
const unnecessaryCharRegex = /([#*!?:(){}|\[\].,+\-_–—=<>%@&$"“”’'`~;/\\\t\r\n]|\d+|[【】「」（）。°•…])/g;
const commonEmojiRegex = /([\uE000-\uF8FF]|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDDFF]|\p{Emoji})/gu;

const detectLanguagePromiseGenerator = function (text) {
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    // 'Authorization': `Bearer ${LANGUAGE_DETECTOR_TOKEN}`
  };
  return retry(() => axios({
    url: LANGUAGE_DETECTOR_ENDPOINT,
    method: 'POST',
    headers: reqHeaders,
    data: { "q": text, "api_key": LANGUAGE_DETECTOR_TOKEN }
  }), axiosRetryStrategy);
};

const detectLanguage = async function (text) {
  const result = await detectLanguagePromiseGenerator(text);
  return result;
}

const createLanguageClassificationEvent = (detectedLanguage, privateKey, taggedId, taggedAuthor) => {
  let languageClassificationEvent = {
    id: "",
    pubkey: getPublicKey(privateKey),
    kind: 9978,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", "nostr-language-classification"],
      ["t", "nostr-language-classification"],
      ["e", taggedId],
      ["p", taggedAuthor],
    ],
    content: JSON.stringify(detectedLanguage),
    sig: ""
  }
  languageClassificationEvent.id = getEventHash(languageClassificationEvent);
  languageClassificationEvent.sig = getSignature(languageClassificationEvent, privateKey);
  let ok = validateEvent(languageClassificationEvent);
  if (!ok) return undefined;
  let veryOk = verifySignature(languageClassificationEvent);
  if (!veryOk) return undefined;
  return languageClassificationEvent;
};

const classifyUrlNsfwDetectorPromiseGenerator = function (url) {
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${NSFW_DETECTOR_TOKEN}`
  };
  return requestLimiter(() => retry(() => axios({
    url: NSFW_DETECTOR_ENDPOINT,
    method: 'POST',
    headers: reqHeaders,
    data: { "url": url }
  }), axiosRetryStrategy));
};

const classifyUrlNsfwDetector = async (imgUrl, metadata) => {
  const classifyUrlNsfwDetectorList = imgUrl.map((url) => classifyUrlNsfwDetectorPromiseGenerator(url));
  const rawOutput = await Promise.allSettled(classifyUrlNsfwDetectorList);

  const classificationOutput = rawOutput.map((item) => {
    let output = {};
    output.id = metadata.id;
    output.author = metadata.author;
    output.is_activitypub_user = metadata.is_activitypub_user;
    output.has_content_warning = metadata.has_content_warning;
    output.has_nsfw_hashtag = metadata.has_nsfw_hashtag;

    if (item.status === 'fulfilled') {
      const nsfwProbability = 1 - parseFloat(item.value.data.data.neutral);
      output.status = true;
      output.data = item.value.data.data;
      output.probably_nsfw = nsfwProbability >= 0.75;
      output.high_probably_nsfw = nsfwProbability >= 0.85;
      output.responsible_nsfw = (!output.probably_nsfw) ? true : output.probably_nsfw && (output.has_content_warning || output.has_nsfw_hashtag);
    }
    else {
      output.status = false;
      output.data = item.reason.message;
      output.probably_nsfw = false;
      output.high_probably_nsfw = false;
      output.responsible_nsfw = true;
    }
    return output;
  });

  for (let index = 0; index < imgUrl.length; index++) {
    const element = imgUrl[index];
    classificationOutput[index].url = element;
  }

  const classificationData = classificationOutput.filter(m => m.status === true).map(m => {
    return {
      id: m.id,
      author: m.author,
      is_activitypub_user: m.is_activitypub_user,
      has_content_warning: m.has_content_warning,
      has_nsfw_hashtag: m.has_nsfw_hashtag,
      probably_nsfw: m.probably_nsfw,
      high_probably_nsfw: m.high_probably_nsfw,
      responsible_nsfw: m.responsible_nsfw,
      data: m.data,
      url: m.url,
    };
  });
  // const classificationData = classificationOutput.filter(m => m.status === true);
  return classificationData;
};

const createNsfwClassificationEvent = (nsfwClassificationData, privateKey, taggedId, taggedAuthor) => {
  let nsfwClassificationEvent = {
    id: "",
    pubkey: getPublicKey(privateKey),
    kind: 9978,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", "nostr-nsfw-classification"],
      ["t", "nostr-nsfw-classification"],
      ["e", taggedId],
      ["p", taggedAuthor],
    ],
    content: JSON.stringify(nsfwClassificationData),
    sig: ""
  }
  nsfwClassificationEvent.id = getEventHash(nsfwClassificationEvent);
  nsfwClassificationEvent.sig = getSignature(nsfwClassificationEvent, privateKey);
  let ok = validateEvent(nsfwClassificationEvent);
  if (!ok) return undefined;
  let veryOk = verifySignature(nsfwClassificationEvent);
  if (!veryOk) return undefined;
  return nsfwClassificationEvent;
};

const publishNostrEvent = async (pool, relaysToPublish, event) => {
  try {
    let pubs = pool.publish(relaysToPublish, event);
    // Ignore errors that happens when publishing
    await Promise.allSettled(pubs);
    console.debug("Event published ", event.id);
  } catch (error) {
    console.error(error);
  }
};

const handleNotesEvent = async (relay, sub_id, ev) => {
  const id = ev.id;
  const author = ev.pubkey;
  const kind = parseInt(ev.kind) || 0;
  // Only accept event kind 1 for now
  if (kind !== 1) {
    console.debug("Not kind 1");
    console.debug(relay);
    console.debug(ev);
    // exit(1);
    return;
  }

  const content = ev.content;
  const created_at = ev.created_at;
  const tags = ev.tags;
  const hashtags = extractHashtags(tags);
  const _hasContentWarning = hasContentWarning(tags);
  const _hasNsfwHashtag = hasNsfwHashtag(hashtags);
  const _isActivityPubUser = isActivityPubUser(tags);
  const extractedUrl = extractUrl(content) ?? [];

  console.debug('======================================');
  console.debug('relay = ', relay.url);
  console.debug(`id = ${id}, created_at = ${created_at}, kinds = ${kind}`);
  console.debug('author = ', author);
  console.debug('_isActivityPubUser = ', _isActivityPubUser);
  console.debug('content = ', content);
  console.debug('tags = ', JSON.stringify(tags));
  console.debug('hashtags = ', JSON.stringify(hashtags));
  console.debug('_hasContentWarning = ', _hasContentWarning);
  console.debug('_hasNsfwHashtag = ', _hasNsfwHashtag);
  console.debug('Extracted url = ', extractedUrl.join(', '));
  // Extract only image url
  const imgUrl = extractedUrl.filter((url) => getUrlType(url) === 'image') ?? [];
  console.debug('Img url = ', imgUrl.join(', '));

  if (ENABLE_NSFW_CLASSIFICATION && imgUrl.length > 0) {
    let metadata = {};
    metadata.id = id;
    metadata.author = author;
    metadata.has_content_warning = _hasContentWarning;
    metadata.has_nsfw_hashtag = _hasNsfwHashtag;
    metadata.is_activitypub_user = _isActivityPubUser;

    const nsfwClassificationData = await classifyUrlNsfwDetector(imgUrl, metadata);

    const _isProbablyNSFW = isProbablyNSFWContent(nsfwClassificationData);
    // Mark as reponsible nsfw content if it has content warning or nsfw hashtag
    const _isResponsibleNSFW = (!_isProbablyNSFW) ? true : _isProbablyNSFW && (metadata.has_content_warning || metadata.has_nsfw_hashtag);

    console.debug('_isResponsibleNSFW = ', _isResponsibleNSFW);
    console.debug('_isProbablyNSFW = ', _isProbablyNSFW);
    console.debug('nsfwClassificationData = ', JSON.stringify(nsfwClassificationData));

    const nsfwClassificationEvent = createNsfwClassificationEvent(nsfwClassificationData, NOSTR_MONITORING_BOT_PRIVATE_KEY,
      metadata.id, metadata.author);

    // Publish classification event
    await publishNostrEvent(pool, relaysToPublish, nsfwClassificationEvent);

    if (NODE_ENV !== 'production') fs.appendFile('classification.txt', JSON.stringify(nsfwClassificationData) + "\n");

    if (_isProbablyNSFW && !_isResponsibleNSFW) {
      if (NODE_ENV !== 'production') fs.appendFile('classification_not_responsible_nsfw.txt', JSON.stringify(nsfwClassificationData) + "\n");
    }

    if (_isProbablyNSFW) {
      if (NODE_ENV !== 'production') fs.appendFile('classification_probably_nsfw.txt', JSON.stringify(nsfwClassificationData) + "\n");
      mqttClient.forEach((client) => {
        if (ENABLE_MQTT_PUBLISH) {
          client.publishAsync('nostr-nsfw-classification/1', JSON.stringify(nsfwClassificationEvent)).then(() => {
            console.log(client.options.host, "nostr-nsfw-classification/1", "Published");
          });
        }
      });
    }
    else {
      if (NODE_ENV !== 'production') fs.appendFile('classification_not_probably_nsfw.txt', JSON.stringify(nsfwClassificationData) + "\n");
      mqttClient.forEach((client) => {
        if (ENABLE_MQTT_PUBLISH) {
          client.publishAsync('nostr-nsfw-classification/0', JSON.stringify(nsfwClassificationEvent)).then(() => {
            console.log(client.options.host, "nostr-nsfw-classification/0", "Published");
          });
        }
      });
    }

  }

  if (ENABLE_LANGUAGE_DETECTION) {
    const startTime = performance.now();
    let err, detectedLanguageResponse;
    let text = content;
    const preprocessStartTime = performance.now();
    // Preprocess to replace any NIP-19 mentions (nostr:npub1, nevent1, note1, etc.)
    text = text.replace(MentionNostrEntityRegex, ' ');

    // Preprocess to remove links
    for (let index = 0; index < extractedUrl.length; index++) {
      const url = extractedUrl[index];
      text = text.replaceAll(url, ' ');
    }

    // Preprocess to remove unnecessary characters
    text = text.replace(unnecessaryCharRegex, ' ');

    // Remove unicode emojis
    text = text.replace(commonEmojiRegex, ' ');

    // Replace multiple spaces character into single space character
    text = text.replace(/\s+/g, ' ').trim();

    // Truncate text if needed
    if (LANGUAGE_DETECTOR_TRUNCATE_LENGTH > 0) {
      text = truncateString(text, LANGUAGE_DETECTOR_TRUNCATE_LENGTH);
    }

    const preprocessElapsedTime = performance.now() - preprocessStartTime;

    if (text !== '') {
      [err, detectedLanguageResponse] = await to.default(detectLanguage(text));
      if (err) {
        console.error("Error:", err.message);
      }
    }
    else {
      console.debug("Empty text after preprocessing, original text = ", content);
      err = new Error("Empty text");
    }

    const elapsedTime = performance.now() - startTime;
    const defaultResult = [{ confidence: 0, language: 'en' }];
    const detectedLanguage = (!err) ? detectedLanguageResponse.data : defaultResult;

    // console.debug(text);
    console.debug("detectedLanguage", JSON.stringify(detectedLanguage), elapsedTime);
    // console.debug(preprocessElapsedTime);
    // console.debug(elapsedTime);
    // if (elapsedTime > 300) {
    //   console.debug(text);
    //   console.debug(detectedLanguage);
    //   console.debug(preprocessElapsedTime);
    //   console.debug(elapsedTime);
    // }

    const languageClassificationEvent = createLanguageClassificationEvent(detectedLanguage, NOSTR_MONITORING_BOT_PRIVATE_KEY, id, author);
    // console.debug(languageClassificationEvent);

    // Publish languageClassificationEvent
    await publishNostrEvent(pool, relaysToPublish, languageClassificationEvent);

    mqttClient.forEach((client) => {
      if (ENABLE_MQTT_PUBLISH) {
        client.publishAsync('nostr-language-classification', JSON.stringify(languageClassificationEvent)).then(() => {
          console.log(client.options.host, "nostr-language-classification", "Published");
        });
      }
    });
  }

  // Broadcast nostr note events to target relay after classification
  await publishNostrEvent(pool, relaysToPublish, ev);
};

let eventCounter = {};
// event counter stats viewer
setInterval(() => {
  console.info("event counter stats per relay");
  console.info(eventCounter);
}, 60 * 1000);

const handleNostrEvent = async (relay, sub_id, ev) => {
  // Set event counter
  if (typeof eventCounter[relay.url] !== 'undefined') {
    eventCounter[relay.url] += 1;
  }
  else {
    eventCounter[relay.url] = 1;
  }

  if (eventCache.has(ev.id)) {
    return;
    console.warn("You shouldn't see this unless return not working properly");
  }
  eventCache.set(ev.id, ev);

  const isValidStructure = validateEvent(ev);
  if (!isValidStructure) return;

  const isValidSignature = verifySignature(ev);
  if (!isValidSignature) {
    console.debug("Invalid event = ", JSON.stringify(ev));
    console.debug(relay.url);
    ev.relay = relay.url;
    if (NODE_ENV !== 'production') fs.appendFile('invalid_events.txt', JSON.stringify(ev) + "\n");
    // exit(1);
    eventCache.delete(ev.id);
    return;
  }

  // Only process events not older than sixty minutes ago
  if (ev.created_at < nMinutesAgo(60)) {
    // console.warn("Event older than 60 minutes ago from", relay.url);
    // console.warn(JSON.stringify(ev));
    return;
  }

  // Broadcast nostr events to mqtt broker if needed
  mqttClient.forEach((client) => {
    if (ENABLE_MQTT_PUBLISH) {
      client.publishAsync('nostr-events', JSON.stringify(ev)).then(() => {
        console.log(client.options.host, "nostr-events", "Published");
      });
    }
  });

  try {
    const kind = parseInt(ev.kind);
    switch (kind) {
      case 1:
        await handleNotesEvent(relay, sub_id, ev);
        break;

      default:
        // Broadcast nostr events to target relay
        await publishNostrEvent(pool, relaysToPublish, ev);
        break;
    }
  } catch (error) {
    console.error(error);
  }
};

async function runRelayPool() {
  if (isInRelayPollFunction) return;
  isInRelayPollFunction = true;

  if (relayPool) {
    relayPool.close();
  }

  relayPool = RelayPool(Array.from(relays), { reconnect: true });

  const subIdForNotes = uuidv4().substring(0, 4);

  relayPool.on('open', relay => {
    relay.subscribe(subIdForNotes,
      {
        kinds: [1],
        limit: 1
      }
    );
  });

  relayPool.on('eose', relay => {
    console.debug("EOSE ", relay.url);
    // return;
  });

  relayPool.on('event', handleNostrEvent);

  relayPool.on('error', (relay, e) => {
    console.debug("Error", relay.url, e.message)
  })

  isInRelayPollFunction = false;
}

async function main() {
  let err, response;
  [err, response] = await to.default(
    retry(() => axios.get("http://localhost:8081"), axiosRetryStrategy));

  if (err) {
    return console.error(err);
  }
  console.debug(response.data);
}

// main();
try {
  runRelayPool();
} catch (error) {
  console.error(error);
  runRelayPool();
}