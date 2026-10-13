# The wording changes of each pull request that changes docs/spec/,
# checked by `npm run check:spec-sentences`
# (scripts/check-spec-sentence-moves.mjs, whose header gives the format).
#
# A pull request changing docs/spec/ writes its own list to
# docs/spec/wording-changes/<branch>.txt: one "- old -> new" line for each
# sentence, heading, table row or code line it adds, drops or rewords, "-"
# standing for none. A unit moved unchanged, or whose only change is a link
# target, is not listed.
#
# The check reads only the files in this directory that the branch adds or
# modifies, and never this one. A file the branch adds is read whole; in a file
# it modifies, only the lines it adds count. A branch named README writes
# README-branch.txt. A branch whose name matches a merged list appends to that
# file, and the merged entries are not read.
