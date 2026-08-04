import type { DatabaseMigration } from "./migration"

// Upstream builds this list with a top-level `await Promise.all([...])` over
// dynamic imports. Static imports are equivalent here — every specifier is a
// literal and all of them are awaited before anything reads the list — and they
// avoid two problems for `nub compile`.
//
// The top-level await marked this module async, and with it the whole database /
// location / project subgraph that imports it. Bundled, those become Rolldown
// `await init_x()` initializers, which linearize what ESM evaluates as a single
// strongly connected component; the cycle location -> project -> directories ->
// database -> location then has a module awaiting its own in-flight initializer
// and the program hangs before main with no error at all.
//
// Static imports also let the bundler place these 38 modules in the main graph
// rather than emitting 38 separate lazily-loaded chunks.
import m_20260127222353_familiar_lady_ursula from "./migration/20260127222353_familiar_lady_ursula"
import m_20260211171708_add_project_commands from "./migration/20260211171708_add_project_commands"
import m_20260213144116_wakeful_the_professor from "./migration/20260213144116_wakeful_the_professor"
import m_20260225215848_workspace from "./migration/20260225215848_workspace"
import m_20260227213759_add_session_workspace_id from "./migration/20260227213759_add_session_workspace_id"
import m_20260228203230_blue_harpoon from "./migration/20260228203230_blue_harpoon"
import m_20260303231226_add_workspace_fields from "./migration/20260303231226_add_workspace_fields"
import m_20260309230000_move_org_to_state from "./migration/20260309230000_move_org_to_state"
import m_20260312043431_session_message_cursor from "./migration/20260312043431_session_message_cursor"
import m_20260323234822_events from "./migration/20260323234822_events"
import m_20260410174513_workspace_name from "./migration/20260410174513_workspace-name"
import m_20260413175956_chief_energizer from "./migration/20260413175956_chief_energizer"
import m_20260423070820_add_icon_url_override from "./migration/20260423070820_add_icon_url_override"
import m_20260427172553_slow_nightmare from "./migration/20260427172553_slow_nightmare"
import m_20260428004200_add_session_path from "./migration/20260428004200_add_session_path"
import m_20260501142318_next_venus from "./migration/20260501142318_next_venus"
import m_20260504145000_add_sync_owner from "./migration/20260504145000_add_sync_owner"
import m_20260507164347_add_workspace_time from "./migration/20260507164347_add_workspace_time"
import m_20260510033149_session_usage from "./migration/20260510033149_session_usage"
import m_20260511000411_data_migration_state from "./migration/20260511000411_data_migration_state"
import m_20260511173437_session_metadata from "./migration/20260511173437_session-metadata"
import m_20260601010001_normalize_storage_paths from "./migration/20260601010001_normalize_storage_paths"
import m_20260601202201_amazing_prowler from "./migration/20260601202201_amazing_prowler"
import m_20260602002951_lowly_union_jack from "./migration/20260602002951_lowly_union_jack"
import m_20260602182828_add_project_directories from "./migration/20260602182828_add_project_directories"
import m_20260603001617_session_message_projection_indexes from "./migration/20260603001617_session_message_projection_indexes"
import m_20260603040000_session_message_projection_order from "./migration/20260603040000_session_message_projection_order"
import m_20260603141458_session_input_inbox from "./migration/20260603141458_session_input_inbox"
import m_20260603160727_jittery_ezekiel_stane from "./migration/20260603160727_jittery_ezekiel_stane"
import m_20260604172448_event_sourced_session_input from "./migration/20260604172448_event_sourced_session_input"
import m_20260605003541_add_session_context_snapshot from "./migration/20260605003541_add_session_context_snapshot"
import m_20260605042240_add_context_epoch_agent from "./migration/20260605042240_add_context_epoch_agent"
import m_20260611035744_credential from "./migration/20260611035744_credential"
import m_20260611192811_lush_chimera from "./migration/20260611192811_lush_chimera"
import m_20260612174303_project_dir_strategy from "./migration/20260612174303_project_dir_strategy"
import m_20260622142730_simplify_session_context_epoch from "./migration/20260622142730_simplify_session_context_epoch"
import m_20260622170816_reset_v2_session_state from "./migration/20260622170816_reset_v2_session_state"
import m_20260622202450_simplify_session_input from "./migration/20260622202450_simplify_session_input"

export const migrations = [
  m_20260127222353_familiar_lady_ursula,
  m_20260211171708_add_project_commands,
  m_20260213144116_wakeful_the_professor,
  m_20260225215848_workspace,
  m_20260227213759_add_session_workspace_id,
  m_20260228203230_blue_harpoon,
  m_20260303231226_add_workspace_fields,
  m_20260309230000_move_org_to_state,
  m_20260312043431_session_message_cursor,
  m_20260323234822_events,
  m_20260410174513_workspace_name,
  m_20260413175956_chief_energizer,
  m_20260423070820_add_icon_url_override,
  m_20260427172553_slow_nightmare,
  m_20260428004200_add_session_path,
  m_20260501142318_next_venus,
  m_20260504145000_add_sync_owner,
  m_20260507164347_add_workspace_time,
  m_20260510033149_session_usage,
  m_20260511000411_data_migration_state,
  m_20260511173437_session_metadata,
  m_20260601010001_normalize_storage_paths,
  m_20260601202201_amazing_prowler,
  m_20260602002951_lowly_union_jack,
  m_20260602182828_add_project_directories,
  m_20260603001617_session_message_projection_indexes,
  m_20260603040000_session_message_projection_order,
  m_20260603141458_session_input_inbox,
  m_20260603160727_jittery_ezekiel_stane,
  m_20260604172448_event_sourced_session_input,
  m_20260605003541_add_session_context_snapshot,
  m_20260605042240_add_context_epoch_agent,
  m_20260611035744_credential,
  m_20260611192811_lush_chimera,
  m_20260612174303_project_dir_strategy,
  m_20260622142730_simplify_session_context_epoch,
  m_20260622170816_reset_v2_session_state,
  m_20260622202450_simplify_session_input,
] satisfies DatabaseMigration.Migration[]
