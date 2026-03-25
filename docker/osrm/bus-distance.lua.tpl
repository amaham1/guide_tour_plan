local base = dofile("/opt/car.lua")
local base_setup = base.setup
local base_process_way = base.process_way

local function apply_bus_overrides(profile)
  profile.properties.weight_name = "distance"
  profile.properties.use_turn_restrictions = true

  profile.access_tag_whitelist["psv"] = true
  profile.access_tag_whitelist["bus"] = true
  profile.access_tag_whitelist["designated"] = true
  profile.access_tag_blacklist["psv"] = nil
  profile.access_tag_blacklist["bus"] = nil

  profile.access_tags_hierarchy = Sequence {
    "bus",
    "psv",
    "motorcar",
    "motor_vehicle",
    "vehicle",
    "access"
  }

  profile.restrictions = Sequence {
    "bus",
    "psv",
    "motorcar",
    "motor_vehicle",
    "vehicle"
  }

  profile.vehicle_height = __BUS_HEIGHT__
  profile.vehicle_width = __BUS_WIDTH__
  profile.vehicle_length = __BUS_LENGTH__
  profile.vehicle_weight = __BUS_WEIGHT__

  profile.speeds.highway.busway = 40
  profile.restricted_highway_whitelist["busway"] = true

  return profile
end

function setup()
  return apply_bus_overrides(base_setup())
end

function process_way(profile, way, result, relations)
  base_process_way(profile, way, result, relations)

  local busway = way:get_value_by_key("busway")
  local psv_lanes = way:get_value_by_key("lanes:psv") or way:get_value_by_key("psv:lanes")
  local bus_lanes = way:get_value_by_key("lanes:bus") or way:get_value_by_key("bus:lanes")
  local highway = way:get_value_by_key("highway")

  local has_bus_lane =
    highway == "busway" or
    busway == "lane" or
    busway == "opposite" or
    busway == "opposite_lane" or
    (psv_lanes and string.find(psv_lanes, "designated")) or
    (bus_lanes and string.find(bus_lanes, "designated"))

  if has_bus_lane then
    if result.forward_speed and result.forward_speed > 0 then
      result.forward_speed = result.forward_speed * 1.15
    end

    if result.backward_speed and result.backward_speed > 0 then
      result.backward_speed = result.backward_speed * 1.15
    end
  end
end

return {
  setup = setup,
  process_way = process_way,
  process_node = base.process_node,
  process_turn = base.process_turn
}
