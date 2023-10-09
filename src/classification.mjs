export const isProbablyNSFWContent = (output, nsfwConfidenceThresold = 0.75) => {
  let result = false;
  for (let index = 0; index < output.length; index++) {
    const classification = output[index];
    if (classification.status === false) continue;
    const nsfwProbability = 1 - parseFloat(classification.data.neutral);
    if (nsfwProbability >= nsfwConfidenceThresold) {
      result = true;
      break;
    }
  }
  return result;
};
