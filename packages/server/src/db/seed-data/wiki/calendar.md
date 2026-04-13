# Calendar & Events

Every server has a calendar for scheduling meetings, standups, reviews, and anything else that has a time.

## Creating Events

Open the calendar from the sidebar and click to create an event. Set a title, start/end time, optional location, and recurrence (daily, weekly, biweekly, monthly).

## RSVP

Every event has three RSVP options: **Going**, **Interested**, and **Not going**. Your RSVP status is visible to other attendees.

## Event Chat

Each event has its own embedded chat — a full message channel with reactions, threads, and translation. Use it for pre-meeting agendas, post-meeting notes, or async discussion.

## Calendar Views

Switch between **Agenda** (upcoming list), **Week** (7-day grid), and **Month** (calendar grid) views using the buttons at the top.

## Recurring Events

Events with a recurrence rule expand into individual instances on the calendar. The recurrence follows RFC 5545 (the iCal standard), so daily, weekly, biweekly, and monthly patterns work as expected.

## Event Embeds

Copy an event's reference with the **"Copy embed reference"** button, then paste `[[event:slug]]` anywhere. It renders as an inline invite card with RSVP buttons — readers can join the event without opening the calendar.

## Translation

Event titles and descriptions translate through the same tone-preserving pipeline as everything else. A Spanish standup invite lands natively in every reader's preferred language.
