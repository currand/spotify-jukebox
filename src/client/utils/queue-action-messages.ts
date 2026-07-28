import type { QueueItemView } from "@/shared/types";
import { resolveRateLimitMessage } from "@/shared/rate-limit-messages";
import { ApiError } from "../http";

export function upvoteBlockedMessage(
  item: QueueItemView,
  canMutate: boolean,
  isOwn: boolean,
  upvotesLeft?: number,
): string {
  if (!canMutate) return "Party is paused — actions are off";
  if (item.guestUpvoteBlocked) {
    const upNextPending =
      item.status === "pending" && !item.guestVetoBlocked;
    return upNextPending
      ? "Up next — upvotes are locked"
      : "Already queued in Spotify — upvotes are locked";
  }
  if (isOwn) return "You can't upvote your own song";
  if (item.guestHasUpvoted) return "You already upvoted this song";
  if (upvotesLeft === 0) return "No upvotes left";
  return "Can't upvote this song";
}

export function downvoteBlockedMessage(
  item: QueueItemView,
  canMutate: boolean,
  downvotesLeft?: number,
): string {
  if (!canMutate) return "Party is paused — actions are off";
  if (item.guestVetoBlocked) {
    return "Already queued in Spotify — downvotes are locked";
  }
  if (item.guestHasDownvoted) return "You already downvoted this song";
  if (downvotesLeft === 0) return "No downvotes left";
  return "Can't downvote this song";
}

export function boostBlockedMessage(
  item: QueueItemView,
  canMutate: boolean,
  boostsLeft: number,
  partyBoostsRemaining?: number | null,
): string {
  if (!canMutate) return "Party is paused — actions are off";
  if (partyBoostsRemaining === 0) return "Boost limit reached for this party";
  if (item.guestBoostBlocked) {
    const upNextPending =
      item.status === "pending" && !item.guestVetoBlocked;
    return upNextPending
      ? "Up next — boost is locked"
      : "Already queued in Spotify — boost is locked";
  }
  if (item.isBoosted) return "Already boosted";
  if (boostsLeft === 0) return "No boosts left";
  return "Can't boost this song";
}

export function upvoteApiMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case "NEXT_LOCKED":
      return error.message.includes("up next")
        ? "Up next — upvotes are locked"
        : "Already queued in Spotify — upvotes are locked";
    case "OWN_SONG":
      return "You can't upvote your own song";
    case "ALREADY_VOTED":
      return "You already upvoted this song";
    case "RATE_LIMITED":
      return resolveRateLimitMessage(
        error.message,
        "You've used all your upvotes.",
      );
    case "PARTY_OFF":
      return "Party is paused — turn it on to vote";
    default:
      return null;
  }
}

export function downvoteApiMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case "NEXT_LOCKED":
      return "Already queued in Spotify — downvotes are locked";
    case "ALREADY_VETOED":
      return "You already downvoted this song";
    case "NOW_PLAYING":
      return "Can't downvote what's playing now";
    case "RATE_LIMITED":
      return resolveRateLimitMessage(
        error.message,
        "You've used all your downvotes.",
      );
    case "PARTY_OFF":
      return "Party is paused — turn it on to vote";
    default:
      return null;
  }
}

export function boostApiMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case "BOOST_USED":
      return "No boosts left";
    case "RATE_LIMITED":
      return resolveRateLimitMessage(
        error.message,
        "You've used your boost.",
      );
    case "ALREADY_BOOSTED":
      return "Already boosted";
    case "NEXT_LOCKED":
      return error.message.includes("up next")
        ? "Up next — boost is locked"
        : "Already queued in Spotify — boost is locked";
    case "PARTY_OFF":
      return "Party is paused — turn it on to boost";
    case "BOOST_CAP":
      return "Boost limit reached for this party";
    default:
      return null;
  }
}
