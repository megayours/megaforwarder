export const secondsFromNow = (seconds: number) => {
  return Date.now() + seconds * 1000;
};

export const minutesFromNow = (minutes: number) => {
  return secondsFromNow(minutes * 60);
};

export const hoursFromNow = (hours: number) => {
  return secondsFromNow(hours * 60 * 60);
};
