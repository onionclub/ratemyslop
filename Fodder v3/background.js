"use strict";

const RYD_CACHE = new Map();
const RYD_CACHE_TTL = 60 * 60 * 1000; // 1 hour cache

async function fetchRYD(videoId) {
  const cached = RYD_CACHE.get(videoId);
  if (cached && Date.now() - cached.timestamp < RYD_CACHE_TTL) return cached.data;
  
  try {
    const response = await fetch(`https://returnyoutubedislikeapi.com/Votes?videoId=${videoId}`);
    const data = await response.json();
    RYD_CACHE.set(videoId, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    return { error: error.message };
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "FETCH_RYD") {
    fetchRYD(request.videoId).then(sendResponse);
    return true;
  }
});