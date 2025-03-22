export const millisecondsFromNow = (milliseconds: number) => {
  return Date.now() + milliseconds;
};

export const secondsFromNow = (seconds: number) => {
  return millisecondsFromNow(seconds * 1000);
};

export const minutesFromNow = (minutes: number) => {
  return secondsFromNow(minutes * 60);
};

export const hoursFromNow = (hours: number) => {
  return secondsFromNow(hours * 60 * 60);
};
