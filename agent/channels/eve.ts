import { disableRoute } from "eve/channels";

// This internal worker deliberately has no general conversation, inspection,
// workflow-control, file, shell, or delegation endpoint.
export default disableRoute();
