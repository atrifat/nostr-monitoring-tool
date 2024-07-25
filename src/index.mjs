
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
import { TokenizerEn, NormalizerEn } from "@nlpjs/lang-en";
import {
  MentionNostrEntityRegex,
  unnecessaryCharRegex,
  fullUnnecessaryCharRegex,
  commonEmojiRegex,
  ordinalPatternRegex,
  zapPatternRegex,
  hexStringRegex,
  separateCamelCaseWordsHashtag,
  reduceRepeatingCharacters,
  normalizedNonGoodWordsPattern
} from "./nlp-util.mjs"

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

const ENABLE_HATE_SPEECH_DETECTION = process.env.ENABLE_HATE_SPEECH_DETECTION ? process.env.ENABLE_HATE_SPEECH_DETECTION === 'true' : false;
const HATE_SPEECH_DETECTOR_ENDPOINT = process.env.HATE_SPEECH_DETECTOR_ENDPOINT || "";
const HATE_SPEECH_DETECTOR_TOKEN = process.env.HATE_SPEECH_DETECTOR_TOKEN || "";
const HATE_SPEECH_DETECTOR_TRUNCATE_LENGTH = parseInt(process.env.HATE_SPEECH_DETECTOR_TRUNCATE_LENGTH || "350");
if (Number.isNaN(HATE_SPEECH_DETECTOR_TRUNCATE_LENGTH) || HATE_SPEECH_DETECTOR_TRUNCATE_LENGTH < 0) {
  handleFatalError(new Error("Invalid HATE_SPEECH_DETECTOR_TRUNCATE_LENGTH"));
}

const ENABLE_SENTIMENT_ANALYSIS = process.env.ENABLE_SENTIMENT_ANALYSIS ? process.env.ENABLE_SENTIMENT_ANALYSIS === 'true' : false;
const SENTIMENT_ANALYSIS_ENDPOINT = process.env.SENTIMENT_ANALYSIS_ENDPOINT || "";
const SENTIMENT_ANALYSIS_TOKEN = process.env.SENTIMENT_ANALYSIS_TOKEN || "";
const SENTIMENT_ANALYSIS_TRUNCATE_LENGTH = parseInt(process.env.SENTIMENT_ANALYSIS_TRUNCATE_LENGTH || "350");
if (Number.isNaN(SENTIMENT_ANALYSIS_TRUNCATE_LENGTH) || SENTIMENT_ANALYSIS_TRUNCATE_LENGTH < 0) {
  handleFatalError(new Error("Invalid SENTIMENT_ANALYSIS_TRUNCATE_LENGTH"));
}

const ENABLE_TOPIC_CLASSIFICATION = process.env.ENABLE_TOPIC_CLASSIFICATION ? process.env.ENABLE_TOPIC_CLASSIFICATION === 'true' : false;
const TOPIC_CLASSIFICATION_ENDPOINT = process.env.TOPIC_CLASSIFICATION_ENDPOINT || "";
const TOPIC_CLASSIFICATION_TOKEN = process.env.TOPIC_CLASSIFICATION_TOKEN || "";
const TOPIC_CLASSIFICATION_TRUNCATE_LENGTH = parseInt(process.env.TOPIC_CLASSIFICATION_TRUNCATE_LENGTH || "350");
if (Number.isNaN(TOPIC_CLASSIFICATION_TRUNCATE_LENGTH) || TOPIC_CLASSIFICATION_TRUNCATE_LENGTH < 0) {
  handleFatalError(new Error("Invalid TOPIC_CLASSIFICATION_TRUNCATE_LENGTH"));
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

const DELAYS_BEFORE_PUBLISHING_NOTES = parseInt(process.env.DELAYS_BEFORE_PUBLISHING_NOTES || "1000");
const ALLOW_EVENTS_NOT_OLDER_THAN_MINUTES = parseInt(process.env.ALLOW_EVENTS_NOT_OLDER_THAN_MINUTES || "10");

const ENABLE_MQTT_PUBLISH = process.env.ENABLE_MQTT_PUBLISH ? process.env.ENABLE_MQTT_PUBLISH === 'true' : false;

const MQTT_BROKER_TO_PUBLISH =
  (typeof process.env.MQTT_BROKER_TO_PUBLISH !== "undefined" &&
    process.env.MQTT_BROKER_TO_PUBLISH !== "")
    ? process.env.MQTT_BROKER_TO_PUBLISH.split(",").map((broker) => broker.trim())
    : [];

if (ENABLE_MQTT_PUBLISH === true && MQTT_BROKER_TO_PUBLISH.length === 0) {
  handleFatalError(new Error("MQTT_BROKER_TO_PUBLISH is required when ENABLE_MQTT_PUBLISH == true"));
}

// Additional image url regular expression pattern to be used for image classification requests. 
// User can add environment variable like this: IMAGE_URL_PATTERN_0=hostname1.tld IMAGE_URL_PATTERN_1=hostname2.tld IMAGE_URL_PATTERN_2=or_any_pattern
const IMAGE_URL_PATTERN_LIST = Object.keys(process.env)
  .filter(key => key.startsWith('IMAGE_URL_PATTERN_'))
  .map(key => {
    const pattern = process.env[key];
    const match = pattern.match(/^\/(.+)\/([gimy]*)$/);
    if (!match) {
      return new RegExp(pattern);
    } else {
      return new RegExp(match[1], match[2]);
    }
  });

// Override log and debug functions for production environment. Use console.info, console.warn, console.error instead if needed.
if (NODE_ENV === "production") {
  console.log = (...data) => {

  };
  console.debug = (...data) => {

  };
}

const eventCache = new LRUCache(
  {
    max: 5000,
    // how long to live in ms
    ttl: 300000,
  }
);

const requestLimiter = pLimit(10);
const stringNormalizer = new NormalizerEn();
const stringTokenizer = new TokenizerEn();

let mqttBroker = (ENABLE_MQTT_PUBLISH) ? MQTT_BROKER_TO_PUBLISH : [];
let mqttClient = (await Promise.allSettled(mqttBroker.map(url => connectAsync(url))))
  .filter(res => res.status === "fulfilled").map(res => res.value);

let isInRelayPollFunction = false;
let relayPool;

const pool = new SimplePool();

let relays = RELAYS_SOURCE;
let relaysToPublish = RELAYS_TO_PUBLISH;

function axiosRetryStrategy(result, error, attempts) {
  return !!error && attempts < 2 ? attempts * 1000 : -1;
}

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

const createLanguageClassificationEvent = (detectedLanguage, privateKey, taggedId, taggedAuthor, createdAt) => {
  let languageClassificationEvent = {
    id: "",
    pubkey: getPublicKey(privateKey),
    kind: 9978,
    created_at: (createdAt !== undefined) ? createdAt : Math.floor(Date.now() / 1000),
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

const classifyUrlNsfwDetector = async (mediaUrl, metadata) => {
  const classifyUrlNsfwDetectorList = mediaUrl.map((url) => classifyUrlNsfwDetectorPromiseGenerator(url));
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

  for (let index = 0; index < mediaUrl.length; index++) {
    const element = mediaUrl[index];
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

const createNsfwClassificationEvent = (nsfwClassificationData, privateKey, taggedId, taggedAuthor, createdAt) => {
  let nsfwClassificationEvent = {
    id: "",
    pubkey: getPublicKey(privateKey),
    kind: 9978,
    created_at: (createdAt !== undefined) ? createdAt : Math.floor(Date.now() / 1000),
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

const detectHateSpeechPromiseGenerator = function (text) {
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    // 'Authorization': `Bearer ${LANGUAGE_DETECTOR_TOKEN}`
  };
  return retry(() => axios({
    url: HATE_SPEECH_DETECTOR_ENDPOINT,
    method: 'POST',
    headers: reqHeaders,
    data: { "q": text, "api_key": HATE_SPEECH_DETECTOR_TOKEN }
  }), axiosRetryStrategy);
};

const detectHateSpeech = async function (text) {
  const result = await detectHateSpeechPromiseGenerator(text);
  return result;
}

const createHateSpeechClassificationEvent = (detectedHateSpeech, privateKey, taggedId, taggedAuthor, createdAt) => {
  let hateSpeechClassificationEvent = {
    id: "",
    pubkey: getPublicKey(privateKey),
    kind: 9978,
    created_at: (createdAt !== undefined) ? createdAt : Math.floor(Date.now() / 1000),
    tags: [
      ["d", "nostr-hate-speech-classification"],
      ["t", "nostr-hate-speech-classification"],
      ["e", taggedId],
      ["p", taggedAuthor],
    ],
    content: JSON.stringify(detectedHateSpeech),
    sig: ""
  }
  hateSpeechClassificationEvent.id = getEventHash(hateSpeechClassificationEvent);
  hateSpeechClassificationEvent.sig = getSignature(hateSpeechClassificationEvent, privateKey);
  let ok = validateEvent(hateSpeechClassificationEvent);
  if (!ok) return undefined;
  let veryOk = verifySignature(hateSpeechClassificationEvent);
  if (!veryOk) return undefined;
  return hateSpeechClassificationEvent;
};

const detectSentimentPromiseGenerator = function (text) {
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  return retry(() => axios({
    url: SENTIMENT_ANALYSIS_ENDPOINT,
    method: 'POST',
    headers: reqHeaders,
    data: { "q": text, "api_key": SENTIMENT_ANALYSIS_TOKEN }
  }), axiosRetryStrategy);
};

const detectSentiment = async function (text) {
  const result = await detectSentimentPromiseGenerator(text);
  return result;
}

const createSentimentClassificationEvent = (detectedSentiment, privateKey, taggedId, taggedAuthor, createdAt) => {
  let sentimentClassificationEvent = {
    id: "",
    pubkey: getPublicKey(privateKey),
    kind: 9978,
    created_at: (createdAt !== undefined) ? createdAt : Math.floor(Date.now() / 1000),
    tags: [
      ["d", "nostr-sentiment-classification"],
      ["t", "nostr-sentiment-classification"],
      ["e", taggedId],
      ["p", taggedAuthor],
    ],
    content: JSON.stringify(detectedSentiment),
    sig: ""
  }
  sentimentClassificationEvent.id = getEventHash(sentimentClassificationEvent);
  sentimentClassificationEvent.sig = getSignature(sentimentClassificationEvent, privateKey);
  let ok = validateEvent(sentimentClassificationEvent);
  if (!ok) return undefined;
  let veryOk = verifySignature(sentimentClassificationEvent);
  if (!veryOk) return undefined;
  return sentimentClassificationEvent;
};

const classifyTopicPromiseGenerator = function (text) {
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  return retry(() => axios({
    url: TOPIC_CLASSIFICATION_ENDPOINT,
    method: 'POST',
    headers: reqHeaders,
    data: { "q": text, "api_key": TOPIC_CLASSIFICATION_TOKEN }
  }), axiosRetryStrategy);
};

const classifyTopic = async function (text) {
  try {
    const rawResult = await classifyTopicPromiseGenerator(text);
    let result = rawResult.data.map(item => { return { label: item.label.replace("&", "and"), score: item.score }; });
    return { data: result };
  } catch (error) {
    throw error;
  }
}

const createTopicClassificationEvent = (topicClassification, privateKey, taggedId, taggedAuthor, createdAt) => {
  let topicClassificationEvent = {
    id: "",
    pubkey: getPublicKey(privateKey),
    kind: 9978,
    created_at: (createdAt !== undefined) ? createdAt : Math.floor(Date.now() / 1000),
    tags: [
      ["d", "nostr-topic-classification"],
      ["t", "nostr-topic-classification"],
      ["e", taggedId],
      ["p", taggedAuthor],
    ],
    content: JSON.stringify(topicClassification),
    sig: ""
  }
  topicClassificationEvent.id = getEventHash(topicClassificationEvent);
  topicClassificationEvent.sig = getSignature(topicClassificationEvent, privateKey);
  let ok = validateEvent(topicClassificationEvent);
  if (!ok) return undefined;
  let veryOk = verifySignature(topicClassificationEvent);
  if (!veryOk) return undefined;
  return topicClassificationEvent;
};

const publishNostrEvent = async (pool, relaysToPublish, event) => {
  try {
    let pubs = pool.publish(relaysToPublish, event);
    const joinResult = await Promise.all(pubs);
    console.debug("Event published", event.id);
    return true;
  } catch (error) {
    if (error === undefined) {
      console.error("Error publishing", "undefined error");
      return false;
    }
    if (error.message.trim() === "") {
      console.error("Error publishing", "empty message error");
      return true;
    }
    console.error("Error publishing", error.message);
    return false;
  }
};

const preprocessText = async (inputText) => {
  let text;

  // Preprocess to replace any NIP-19 mentions (nostr:npub1, nevent1, note1, etc.)
  text = inputText.replace(MentionNostrEntityRegex, ' ');

  // Extract URL
  const extractedUrl = [... new Set(extractUrl(inputText + ' ') ?? [])];

  // Preprocess to remove links
  for (let index = 0; index < extractedUrl.length; index++) {
    const url = extractedUrl[index];
    text = text.replaceAll(url, ' ');
  }

  // Preprocess to remove ordinal pattern such as: 2nd, 3rd, etc.
  text = text.replace(ordinalPatternRegex, '');

  text = reduceRepeatingCharacters(text);
  text = separateCamelCaseWordsHashtag(text);
  text = normalizedNonGoodWordsPattern(text);

  // Transform zap/zapathon into "tip" to reduce false positive
  text = text.replace(zapPatternRegex, 'tip');

  // Preprocess to remove hex string characters
  text = text.replace(hexStringRegex, ' ');

  // Preprocess to remove unnecessary characters (excluding single quote or double quote)
  text = text.replace(unnecessaryCharRegex, ' ');

  text = stringTokenizer.tokenize(text).join(' ');
  text = stringNormalizer.normalize(text);

  // Remove unicode emojis (disabled by default, since emoji is important in sentiment analysis and hate speech detection)
  // text = text.replace(commonEmojiRegex, ' ');

  // Preprocess to remove full unnecessary characters (including single quote or double quote)
  text = text.replace(fullUnnecessaryCharRegex, '');

  // Replace common greeting patten (good morning)
  text = text.replace(/(^gm\s|\sgm|gm\s|\sgm$)/gm, 'good morning');

  // Replace common greeting patten (good night)
  text = text.replace(/(^gn\s|\sgn|gn\s|\sgn$)/gm, 'good night');

  // Replace common greeting patten (pura vida)
  text = text.replace(/(^pv\s|\spv|pv\s|\spv$)/gm, 'pura vida gratitude happy life');

  // Replace multiple newline character into single space character
  text = text.replace(/\n+/gm, ' ');

  // Replace multiple spaces character into single space character
  text = text.replace(/\s+/gm, ' ');

  text = text.trim().toLowerCase();

  return text;
}

const handleNotesEvent = async (relay, sub_id, ev) => {
  const event = ev;
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
  const extractedUrl = [... new Set(extractUrl(content + ' ') ?? [])];

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
  // Extract only image/video url
  const mediaUrl = extractedUrl.filter((url) => {
    let match = false;
    for (const filter of IMAGE_URL_PATTERN_LIST) {
      if (filter.test(url)) {
        // console.debug(url, "match", filter)
        match = true;
        break;
      }
    }
    return match || getUrlType(url) === 'image' || getUrlType(url) === 'video';
  }) ?? [];
  console.debug('Img/video url = ', mediaUrl.join(', '));

  // NSFW classification event processing
  if (ENABLE_NSFW_CLASSIFICATION && mediaUrl.length > 0) {
    let metadata = {};
    metadata.id = id;
    metadata.author = author;
    metadata.has_content_warning = _hasContentWarning;
    metadata.has_nsfw_hashtag = _hasNsfwHashtag;
    metadata.is_activitypub_user = _isActivityPubUser;

    const nsfwClassificationData = await classifyUrlNsfwDetector(mediaUrl, metadata);

    const _isProbablyNSFW = isProbablyNSFWContent(nsfwClassificationData);
    // Mark as reponsible nsfw content if it has content warning or nsfw hashtag
    const _isResponsibleNSFW = (!_isProbablyNSFW) ? true : _isProbablyNSFW && (metadata.has_content_warning || metadata.has_nsfw_hashtag);

    console.debug('_isResponsibleNSFW = ', _isResponsibleNSFW);
    console.debug('_isProbablyNSFW = ', _isProbablyNSFW);
    console.debug('nsfwClassificationData = ', JSON.stringify(nsfwClassificationData));

    const nsfwClassificationEvent = createNsfwClassificationEvent(nsfwClassificationData, NOSTR_MONITORING_BOT_PRIVATE_KEY,
      metadata.id, metadata.author, created_at);

    // Publish classification event
    if (nsfwClassificationData.length > 0) {
      const publishEventResult = await publishNostrEvent(pool, relaysToPublish, nsfwClassificationEvent);
      if (!publishEventResult) {
        console.info("Fail to publish nsfwClassificationEvent event, try again for the last time");
        await publishNostrEvent(pool, relaysToPublish, nsfwClassificationEvent);
      }
    }

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

  // Text Preprocessing for Classification
  let processedText = await preprocessText(content);

  // Detext empty text
  const isEmptyText = content.replace(/(\n|\s)+/gm, '').trim() === '' && extractedUrl.length === 0;

  // Language detection event processing
  let isEnglish = false;
  if (ENABLE_LANGUAGE_DETECTION && !isEmptyText) {
    const startTime = performance.now();
    let err, detectedLanguageResponse;
    let text = processedText;
    const preprocessStartTime = performance.now();

    // Remove unicode emojis
    text = text.replace(commonEmojiRegex, '');

    // Replace multiple spaces character into single space character
    text = text.replace(/\s+/g, ' ').trim();

    // Truncate text if needed
    if (LANGUAGE_DETECTOR_TRUNCATE_LENGTH > 0) {
      text = truncateString(text, LANGUAGE_DETECTOR_TRUNCATE_LENGTH);
    }

    const finalText = text;
    const preprocessElapsedTime = performance.now() - preprocessStartTime;

    if (finalText !== '') {
      [err, detectedLanguageResponse] = await to.default(detectLanguage(finalText));
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

    for (let i = 0; i < detectedLanguage.length; i++) {
      const languageData = detectedLanguage[i];
      if (languageData.confidence >= 50 && languageData.language === 'en') {
        isEnglish = true;
        break;
      }
    }

    // console.debug(text);
    console.debug("detectedLanguage", JSON.stringify(detectedLanguage), elapsedTime);

    const languageClassificationEvent = createLanguageClassificationEvent(detectedLanguage, NOSTR_MONITORING_BOT_PRIVATE_KEY, id, author, created_at);

    // Publish languageClassificationEvent
    const publishEventResult = await publishNostrEvent(pool, relaysToPublish, languageClassificationEvent);
    if (!publishEventResult) {
      console.info("Fail to publish languageClassificationEvent event, try again for the last time");
      await publishNostrEvent(pool, relaysToPublish, languageClassificationEvent);
    }

    mqttClient.forEach((client) => {
      if (ENABLE_MQTT_PUBLISH) {
        client.publishAsync('nostr-language-classification', JSON.stringify(languageClassificationEvent)).then(() => {
          console.log(client.options.host, "nostr-language-classification", "Published");
        });
      }
    });
  }

  // Hate speech detection event processing
  if (ENABLE_HATE_SPEECH_DETECTION && isEnglish && !isEmptyText) {
    const startTime = performance.now();
    let err, detectedHateSpeechResponse;
    let text = processedText;
    const preprocessStartTime = performance.now();

    // Truncate text if needed
    if (HATE_SPEECH_DETECTOR_TRUNCATE_LENGTH > 0) {
      text = truncateString(text, HATE_SPEECH_DETECTOR_TRUNCATE_LENGTH);
    }

    const finalText = text;
    const preprocessElapsedTime = performance.now() - preprocessStartTime;

    if (finalText !== '') {
      [err, detectedHateSpeechResponse] = await to.default(detectHateSpeech(finalText));
      if (err) {
        console.error("Error:", err.message);
      }
    }
    else {
      console.debug("Empty text after preprocessing, original text = ", content);
      err = new Error("Empty text");
    }

    const elapsedTime = performance.now() - startTime;
    const defaultResult = {
      identity_attack: 0.0,
      insult: 0.0,
      obscene: 0.0,
      severe_toxicity: 0.0,
      sexual_explicit: 0.0,
      threat: 0.0,
      toxicity: 0.0
    };
    const detectedHateSpeech = (!err) ? detectedHateSpeechResponse.data : defaultResult;

    const evalHateSpeechDetection = (detectedHateSpeech, thresold = 0.2) => {
      // If there are value in certain category with score larger than threshold then we conclude there is probably hate speech in the content
      return Object.values(detectedHateSpeech)
        .map(score => parseFloat(score))
        .filter(score => score >= thresold)
        .length > 0;
    };

    const maxScoreHateSpeechDetection = Math.max(...Object.values(detectedHateSpeech)
      .map(score => parseFloat(score)));
    let sumScoreHateSpeechDetection = Object.values(detectedHateSpeech)
      .map(score => parseFloat(score))
      .reduce((a, b) => a + b, 0)
    sumScoreHateSpeechDetection = (sumScoreHateSpeechDetection >= 1) ? 0.99999999999 : sumScoreHateSpeechDetection;

    const hateSpeechThresoldCheck = 0.2;
    // Only publish and process event with minimum probaility score greater than or equal to hateSpeechThresoldCheck
    const isProbablyHateSpeechContent = evalHateSpeechDetection(detectedHateSpeech, hateSpeechThresoldCheck);
    if (isProbablyHateSpeechContent) {
      console.debug("detectedHateSpeech", id, JSON.stringify(detectedHateSpeech), elapsedTime);

      if (NODE_ENV !== 'production') {
        fs.appendFile('classification_probably_hate_speech.txt', JSON.stringify({
          id: id,
          author: author,
          content: content,
          finalText: finalText,
          data: detectedHateSpeech
        }) + "\n");
      }

      const hateSpeechClassificationEvent = createHateSpeechClassificationEvent(detectedHateSpeech, NOSTR_MONITORING_BOT_PRIVATE_KEY, id, author, created_at);

      // Publish hateSpeechClassificationEvent
      const publishEventResult = await publishNostrEvent(pool, relaysToPublish, hateSpeechClassificationEvent);
      if (!publishEventResult) {
        console.info("Fail to publish hateSpeechClassificationEvent event, try again for the last time");
        await publishNostrEvent(pool, relaysToPublish, hateSpeechClassificationEvent);
      }

      mqttClient.forEach((client) => {
        if (ENABLE_MQTT_PUBLISH) {
          client.publishAsync('nostr-hate-speech-classification', JSON.stringify(hateSpeechClassificationEvent)).then(() => {
            console.log(client.options.host, "nostr-hate-speech-classification", "Published");
          });
        }
      });
    }

  }

  // Broadcast nostr note events to target relay after classification with some delay
  setTimeout(async () => {
    const publishEventResult = await publishNostrEvent(pool, relaysToPublish, event);
    if (!publishEventResult) {
      console.info("Fail to publish note event, try again for the last time");
      await publishNostrEvent(pool, relaysToPublish, event);
    }
  }, DELAYS_BEFORE_PUBLISHING_NOTES);

  // Sentiment analysis event processing. This process will be executed after publishing notes.
  if (ENABLE_SENTIMENT_ANALYSIS && isEnglish && !isEmptyText) {
    let text = processedText;

    // Truncate text if needed
    if (SENTIMENT_ANALYSIS_TRUNCATE_LENGTH > 0) {
      text = truncateString(text, SENTIMENT_ANALYSIS_TRUNCATE_LENGTH);
    }

    const finalText = text;
    const startTime = performance.now();

    let err, detectedSentimentResponse;
    if (finalText !== '') {
      [err, detectedSentimentResponse] = await to.default(detectSentiment(finalText));
      if (err) {
        console.error("Error:", err.message);
      }
    }
    else {
      console.debug("Empty text after preprocessing, original text = ", content);
      err = new Error("Empty text");
    }

    const elapsedTime = performance.now() - startTime;

    const defaultResult = {
      negative: 0.0,
      neutral: 0.0,
      positive: 0.0,
    };
    const detectedSentiment = (!err) ? detectedSentimentResponse.data : defaultResult;
    console.debug("detectedSentiment", id, JSON.stringify(detectedSentiment), elapsedTime);

    const sentimentClassificationEvent = createSentimentClassificationEvent(detectedSentiment, NOSTR_MONITORING_BOT_PRIVATE_KEY, id, author, created_at);

    // Publish hateSpeechClassificationEvent
    const publishEventResult = await publishNostrEvent(pool, relaysToPublish, sentimentClassificationEvent);
    if (!publishEventResult) {
      console.info("Fail to publish sentimentClassificationEvent event, try again for the last time");
      await publishNostrEvent(pool, relaysToPublish, sentimentClassificationEvent);
    }

    mqttClient.forEach((client) => {
      if (ENABLE_MQTT_PUBLISH) {
        client.publishAsync('nostr-sentiment-classification', JSON.stringify(sentimentClassificationEvent)).then(() => {
          console.log(client.options.host, "nostr-sentiment-classification", "Published");
        });
      }
    });
  }

  // Topic classification event processing. This process will be executed after publishing notes.
  if (ENABLE_TOPIC_CLASSIFICATION && isEnglish && !isEmptyText) {
    let text = processedText;

    // Truncate text if needed
    if (TOPIC_CLASSIFICATION_TRUNCATE_LENGTH > 0) {
      text = truncateString(text, TOPIC_CLASSIFICATION_TRUNCATE_LENGTH);
    }

    const finalText = text;
    const startTime = performance.now();

    let err, topicClassificationResponse;
    if (finalText !== '') {
      [err, topicClassificationResponse] = await to.default(classifyTopic(finalText));
      if (err) {
        console.error("Error:", err.message);
      }
    }
    else {
      console.debug("Empty text after preprocessing, original text = ", content);
      err = new Error("Empty text");
    }

    const elapsedTime = performance.now() - startTime;

    const defaultResult = [];
    const topicClassificationData = (!err) ? topicClassificationResponse.data : defaultResult;
    console.debug("topicClassificationData", id, JSON.stringify(topicClassificationData), elapsedTime);

    const topicClassificationEvent = createTopicClassificationEvent(topicClassificationData, NOSTR_MONITORING_BOT_PRIVATE_KEY, id, author, created_at);

    // Publish topicClassificationEvent
    const publishEventResult = await publishNostrEvent(pool, relaysToPublish, topicClassificationEvent);
    if (!publishEventResult) {
      console.info("Fail to publish topicClassificationEvent event, try again for the last time");
      await publishNostrEvent(pool, relaysToPublish, topicClassificationEvent);
    }

    mqttClient.forEach((client) => {
      if (ENABLE_MQTT_PUBLISH) {
        client.publishAsync('nostr-topic-classification', JSON.stringify(topicClassificationEvent)).then(() => {
          console.log(client.options.host, "nostr-topic-classification", "Published");
        });
      }
    });
  }
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

  // Only process events not older than (n) minutes ago
  if (ev.created_at < nMinutesAgo(ALLOW_EVENTS_NOT_OLDER_THAN_MINUTES)) {
    // console.warn("Event older than " + ALLOW_EVENTS_NOT_OLDER_THAN_MINUTES + " minutes ago from", relay.url);
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

// Interval subscription helper to keep alive connections.
// Some relays will disconnect clients if there is no request or left as idle from the client.
const intervalSubscriptionToKeepAliveConnection = setInterval(() => {
  // Ensure that relayPool is initialized
  if (!relayPool) return;

  const intervalSubscriptionId = uuidv4().substring(0, 4);

  relayPool.subscribe(intervalSubscriptionId, {
    kinds: [1],
    limit: 10
  });

  // Unsubscribe after few seconds
  setTimeout(() => {
    relayPool.unsubscribe(intervalSubscriptionId);
  }, 5 * 1000);
}, 25 * 1000);

async function runRelayPool() {
  if (isInRelayPollFunction) return;
  isInRelayPollFunction = true;

  if (relayPool) {
    relayPool.close();
  }

  relayPool = RelayPool(Array.from(relays), { reconnect: true });

  relayPool.on('open', relay => {
    const subIdForNotes = uuidv4().substring(0, 4);

    relay.subscribe(subIdForNotes,
      {
        kinds: [1],
        limit: 50
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