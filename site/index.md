# Find the people you have in common. Keep the rest of your records to yourself.

Alcove is open-source software that lets two organizations find the people they have in common, and optionally exchange data about them, without either one revealing the records the other does not have.
Each learns how many records the other holds.

## How it works

Alcove performs privacy-preserving record linkage with a cryptographic protocol called private set intersection.

- Each organization runs Alcove itself, on its own machine or in its own browser.
  No service in the middle holds the data.
- Records are matched in encrypted form.
  Neither organization sends the other its file or the records that did not match.
- For the people in both files, each organization receives only the columns the other agreed in advance to share.

## Three ways to use it

- **In your browser**, with nothing to install.
  Your file is read and matched inside the browser and never uploaded to our servers.
- **On your own machine**, from a guided screen that sets up and runs one exchange, so you can try one with test data first.
- **From the command line**, for IT teams fitting linkage into a data pipeline.

You and your partner do not have to choose the same one.
To start, [choose a guide](guides/index.md).
For the design, security, and compliance documents, read the [documentation](../docs/README.md).

## Open source

Alcove is free, open-source software under the [Apache License 2.0](../LICENSE.md), built at Georgetown University's Massive Data Institute.
Read [who it is for](who-it-is-for.md), [about the team](about.md), and [how to get in touch](contact.md).
