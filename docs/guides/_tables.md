<!-- Table text more than one guide shows, one region each: column-use is the column-use table of the web app and console guides; keys-app and keys-cli are the verification-keys row of a "What you get" table, keys-app where the file is a download and keys-cli where a run writes it. The two keys rows keep one description. The site does not publish this file as a page. -->

<!-- #region column-use -->
| Option | What it does | Pick it when |
| --- | --- | --- |
| **Used to match - not sent** | Matches on the column and never sends it | Usual: names, date of birth, SSN, ZIP code |
| **Used to match - sent to your partner** | Matches on it, and sends its value for matched records | Your partner agreed to receive this column |
| **Unique record identifier - not sent** | Starts each row of your result with your own ID | Usual: your own ID column, whatever it is called |
| **Unique record identifier - sent to your partner** | Does the same, and sends the ID for matched records | Your partner agreed to receive your IDs |
| **Sent to your partner** | Sends the value for matched records; not used to match | Your partner agreed to receive this column |
| **Ignored** | Neither matches on it nor sends it | Usual: every other column |
<!-- #endregion column-use -->

<!-- #region keys-app -->
| `alcove-record-<time>.keys.json` (**Download verification keys**, marked keep private) | The keys that check the record against your files. They cannot be recreated. | Keep private |
<!-- #endregion keys-app -->

<!-- #region keys-cli -->
| `alcove-record-<time>.keys.json` | The keys that check the record against your files. They cannot be recreated. | Keep private |
<!-- #endregion keys-cli -->
