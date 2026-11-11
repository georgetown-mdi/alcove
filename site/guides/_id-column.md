<!-- The ID-column paragraph of the guides, which include one region each: app in the web app and console guides, cli in the command-line guides. The site does not publish this file as a page. -->

<!-- #region app -->
**Your ID column.** Set your own ID column, whatever it is called, to **Unique record identifier - not sent**.
Your result then starts each row with your own ID, and your partner never receives it.
Alcove recognizes common ID names, such as `id`, `Client ID`, `MRN`, and `case_number` ([inference table](../../docs/EXCHANGE_REFERENCE.md#input-metadata)), and starts the first one as **Unique record identifier - not sent**, taking a record number such as `case_number` only when the file has no other ID column.
To send your ID for matched records, choose **Unique record identifier - sent to your partner**.
A column the app does not recognize starts as **Ignored**.
With no column set as your ID, your result holds row numbers only, counting from 0.
<!-- #endregion app -->

<!-- #region cli -->
**Your ID column.** Set your own ID column, whatever it is called: its entry reads `role: identifier`.
Your result then starts each row with your own ID.
With `is_payload: false` your partner never receives it; to send it for matched records, change that to `is_payload: true`.
Alcove recognizes common ID names, such as `id`, `Client ID`, `MRN`, and `case_number` ([inference table](../../docs/EXCHANGE_REFERENCE.md#input-metadata)), and writes an entry for the first one with `is_payload: false`, taking a record number such as `case_number` only when the file has no other ID column.
With no ID column, your result holds row numbers only, counting from 0.
<!-- #endregion cli -->
