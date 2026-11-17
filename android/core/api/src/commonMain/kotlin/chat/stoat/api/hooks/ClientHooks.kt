package chat.stoat.api.hooks

import chat.stoat.core.model.schemas.Message
import kotlinx.coroutines.CancellationException
import kotlin.concurrent.Volatile

/**
 * Stoat+: lets the app (its plugin engine) look at messages before the rest of
 * the app sees them. Unset, everything passes through untouched.
 */
object ClientHooks {
    /**
     * Gets messages from the live connection (`live = true`) or from history,
     * and returns one entry per message: the message, possibly changed, or
     * null to drop it.
     */
    @Volatile
    var incomingMessages: (suspend (messages: List<Message>, live: Boolean) -> List<Message?>)? = null

    suspend fun applyIncoming(messages: List<Message>, live: Boolean): List<Message?> {
        val hook = incomingMessages ?: return messages
        if (messages.isEmpty()) return messages
        return try {
            hook(messages, live).takeIf { it.size == messages.size } ?: messages
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            messages
        }
    }
}
