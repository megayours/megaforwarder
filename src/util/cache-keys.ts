export const getBlockNumberCacheKey = (chain: string) => {
  return `${chain.toLowerCase()}-block-number`;
}
