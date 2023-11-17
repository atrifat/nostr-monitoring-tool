export const camelCaseTitleCaseRegex = /(#([a-zA-Z]{1,})?([A-Z]{1}[a-z]{1,}){1,})/g;
export const camelCaseSeparatorRegex = /([a-z][A-Z])/g;
export const ordinalPatternRegex = /\d+(st|nd|rd|th)/ig;
export const zapPatternRegex = /(zaps?(athon)?)/ig;
export const repeatingCharacterRegex = /a{3,}|b{3,}|c{3,}|d{3,}|e{3,}|f{3,}|g{3,}|h{3,}|i{3,}|j{3,}|k{3,}|l{3,}|m{3,}|n{3,}|o{3,}|p{3,}|q{3,}|r{3,}|s{3,}|t{3,}|u{3,}|v{3,}|w{3,}|x{3,}|y{3,}|z{3,}/ig;

export const MentionNostrEntityRegex = /(nostr:)?@?(nsec1|npub1|nevent1|naddr1|note1|nprofile1|nrelay1)([qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)([\\\\S]*)/gi;
export const unnecessaryCharRegex = /([#*!?:(){}|\[\].,+\-_–—=<>%@&$~;/\\\t\r\n]|\d+|[【】「」（）。°•…])/g;
export const fullUnnecessaryCharRegex = /([#*!?:(){}|\[\].,+\-_–—=<>%@&$"“”’'`~;/\\\t\r\n]|\d+|[【】「」（）。°•…])/g;
export const commonEmojiRegex = /([\uE000-\uF8FF]|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDDFF]|\p{Emoji})/gu;
export const hexStringRegex = /(0x)?[0-9a-f]{6,}/ig;

// List of non good words pattern
export const n1ggerPatternRegex = /(\w+)?(n(i|1|l|\||!)g{2,}(ay?|ers?|4|3rs?|uh))/ig;
export const n1ggersCommonForm = 'n' + 'i' + 'g' + 'g' + 'e' + 'r' + 's';
export const f4ggotsPatternRegex = /fags?(\s|\n|\.|,|\?|!|'|"|\(|\)|\[|\]|{|}|$)|faggots/ig;
export const f4ggotsCommonForm = 'f' + 'a' + 'g' + 'g' + 'o' + 't';
export const c1_1ntsPatternRegex = /cunts?(\s|\n|\.|,|\?|!|'|"|\(|\)|\[|\]|{|}|$)/ig;
export const c1_1ntCommonForm = 'c' + 'u' + 'n' + 't';

// This function will separate camelCase pattern in hashtag
// example: "#WorldSummit" becomes "#World Summit"
export const separateCamelCaseWordsHashtag = (text) => {
    let finalOuput = text;
    const camelCaseTitleCaseRegexGroup = Array.from(text.matchAll(camelCaseTitleCaseRegex)).map((m) => m[1]);
    // console.debug(camelCaseTitleCaseRegexGroup);
    for (const item of camelCaseTitleCaseRegexGroup) {
        const camelCaseSeparatorRegexGroup = Array.from(item.matchAll(camelCaseSeparatorRegex)).map((m) => m[1]);
        let finalItem = item;
        if (camelCaseSeparatorRegexGroup.length == 0) continue;

        // console.debug(camelCaseSeparatorRegexGroup);
        for (const camelCaseSeparator of camelCaseSeparatorRegexGroup) {
            // add space between camelCase separator thus separate them into independent words
            // example: from "camelCase" becomes "camel Case"
            finalItem = finalItem.replace(camelCaseSeparator, camelCaseSeparator[0] + ' ' + camelCaseSeparator[1]);
        }

        // console.debug(finalItem);
        finalOuput = finalOuput.replace(item, finalItem);
    }
    // console.debug(finalOuput);
    return finalOuput;
};

// This function will reduce repeating characters (more than 3 characters) into 2 characters form 
// example: "cooool" becomes "cool"
export const reduceRepeatingCharacters = (text) => {
    let finalOuput = text;

    const repeatingCharacterRegexGroup = Array.from(text.matchAll(repeatingCharacterRegex)).map((m) => m[0]);

    // console.debug(repeatingCharacterRegexGroup);
    for (const item of repeatingCharacterRegexGroup) {
        const finalItem = item.slice(0, 2);

        // Replace characters into 2 times repeating characters
        finalOuput = finalOuput.replace(item, finalItem);
    }

    return finalOuput;
};

// This function will normalized the string in non good words (popular) such as: n*gga, c*nt, and f*g
export const normalizedNonGoodWordsPattern = (text) => {
    let finalOutput = text;
    finalOutput = finalOutput.replace(n1ggerPatternRegex, n1ggersCommonForm + ' ');

    finalOutput = finalOutput.replace(f4ggotsPatternRegex, f4ggotsCommonForm + ' ');

    finalOutput = finalOutput.replace(c1_1ntsPatternRegex, c1_1ntCommonForm + ' ');

    return finalOutput;
};