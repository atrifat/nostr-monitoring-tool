# nostr-monitoring-tool

A simple monitoring tool that classify nostr events (SFW/NSFW, language, topic, sentiment, toxic comment, etc). Currently, this is still a PoC (Proof of Concept) with alpha quality which code can be **changed** drastically.

## Features

It will classify note events (kind: 1) content in various category such as:

- [x] NSFW/SFW content detection using [atrifat/nsfw-detector-api](https://github.com/atrifat/nsfw-detector-api)
- [x] Language detection using [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate)
- [x] Hate speech (Toxic comment) detection using [atrifat/hate-speech-detector-api](https://github.com/atrifat/hate-speech-detector-api)
- [ ] (WIP) Sentiment analysis
- [ ] (Planned) Topic classification

## Requirements

- Personal instance of [atrifat/nsfw-detector-api](https://github.com/atrifat/nsfw-detector-api) (if ENABLE_NSFW_CLASSIFICATION == true)
- Personal instance of [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate) (if ENABLE_LANGUAGE_DETECTION == true)
- Personal instance of [atrifat/hate-speech-detector-api](https://github.com/atrifat/hate-speech-detector-api) (if ENABLE_HATE_SPEECH_DETECTION == true)

## Getting Started

You can start by cloning this repository to run or modify it locally

```
git clone https://github.com/atrifat/nostr-monitoring-tool
cd nostr-monitoring-tool
```

install its dependencies

```
npm install
```

Before running this tool, make sure you have already run your own [atrifat/nsfw-detector-api](https://github.com/atrifat/nsfw-detector-api), [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate), and [atrifat/hate-speech-detector-api](https://github.com/atrifat/hate-speech-detector-api) instance since it is required for content classification. You don't have to run all of them only if you enable classification for certain task (Example: NSFW detection only).

Copy `.env.example` into `.env` and change `.env` value properly

```
cp .env.example .env
```

Now, you can run this tool using command

```
npm run start
```

or run it using node command directly

```
node src/index.mjs
```

This tool will classify note events and publish classification result as nostr event (kind: 9978).
- For NSFW classification, it will publish classification event using **'d'** tag with **'nostr-nsfw-classification'**.
- For language detection, it will publish classification event using **'d'** tag with **'nostr-language-classification'**.
- For hate speech detection, it will publish classification event using **'d'** tag with **'nostr-hate-speech-classification'**.
- Other classification tag (topic classification, sentiment analysis, etc.) will be defined later.

Classification events can be used in another tool such as [nostr-filter-relay](https://github.com/atrifat/nostr-filter-relay) to filter note events.

Classification Event Example:

```
{
    "id": "eventId",
    "created_at": 1696817846,
    "kind": 9978,
    "pubkey": "pubkey",
    "sig": "signature",
    "content": "[{\"id\":\"58bd02d8c46eaa6f1598d5eff7cb33c06ff57c4c9ad3dad32ae2b70d3258f661\",\"author\":\"5fd004926969381ac2bb3a32720036d9f9632d29fb22dc1bf5d8fb1c9e265798\",\"is_activitypub_user\":false,\"has_content_warning\":false,\"has_nsfw_hashtag\":false,\"probably_nsfw\":false,\"high_probably_nsfw\":false,\"responsible_nsfw\":true,\"data\":{\"hentai\":0.0000018745902252703672,\"neutral\":0.9998550415039062,\"pornography\":0.0000746770019759424,\"sexy\":0.00006828152254456654,\"predictedLabel\":\"neutral\"},\"url\":\"https://image.nostr.build/b54386359e8ae33e261f29802ae690afc11f93096d9366c3317dd619f5d55c4a.jpg\"}]",
    "tags": [
        [
            "d",
            "nostr-nsfw-classification"
        ],
        [
            "t",
            "nostr-nsfw-classification"
        ],
        [
            "e",
            "58bd02d8c46eaa6f1598d5eff7cb33c06ff57c4c9ad3dad32ae2b70d3258f661"
        ],
        [
            "p",
            "5fd004926969381ac2bb3a32720036d9f9632d29fb22dc1bf5d8fb1c9e265798"
        ]
    ]
}
```

## License

MIT License

Copyright (c) 2023 Rif'at Ahdi Ramadhani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Author

Rif'at Ahdi Ramadhani (atrifat)
