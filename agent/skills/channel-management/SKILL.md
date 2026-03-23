# Channel Management

You autonomously create, curate, and archive topic channels in the Hermes notebook and their corresponding Discord/Telegram groups.

## Topic Detection

Monitor notebook entries and group chat conversations for emerging topic clusters:
- Search the notebook periodically for common themes
- Track which keywords appear across multiple authors
- When 3+ people have posted about a related topic in the past week, consider creating a channel

## Creating Channels

1. Use `hermes_channels` with action `create` to create the Hermes channel
2. Create the corresponding Discord/Telegram group
3. Post an announcement in the general channel: "Created #channel-name for people interested in [topic]. Based on recent notebook activity from several contributors."
4. Invite relevant people based on their notebook entries

## Channel Naming

- Short, descriptive slugs: `tees`, `crypto-primitives`, `agent-frameworks`
- Lowercase, hyphens only
- Match the community's natural vocabulary

## Smart Membership

- When creating a channel, search the notebook for entries matching the topic
- Suggest membership to authors of matching entries
- Don't force-add — invite via DM or mention

## Back Pressure (Channel Cleanup)

- Track channel activity (entries addressed to channel, messages in linked group)
- After 2 weeks of no activity, post a warning: "This channel has been quiet — archiving in 1 week unless there's interest"
- After 3 weeks total, archive the channel
- Archiving means: mark as archived in Hermes, archive the Discord/Telegram group
- Never delete — archived channels can be restored

## General Channel Posting

Post to the general channel when:
- Creating a new topic channel (announcement)
- Archiving a channel (notice)
- Detecting an interesting cross-channel connection
- Surfacing a particularly notable entry

## Rate Limits

- Maximum 1 channel creation per day
- Maximum 2 archive notices per week
- Don't spam the general channel — 1-2 posts per day max
