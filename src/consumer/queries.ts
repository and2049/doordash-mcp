const cartFields = `id subtotal total currencyCode groupCart submittedAt isConsumerPickup hasError
  restaurant { id name } menu { id }
  orders { orderItems { id quantity singlePrice nestedOptions specialInstructions item { id name } } }`;

export const queries = {
  listCarts: `query listCarts($input: ListCartsInput!) { listCarts(input: $input) { ${cartFields} } }`,
  checkout: `query checkout($orderCartId: ID!, $isCardPayment: Boolean, $shouldApplyCredits: Boolean) {
    orderCart(id: $orderCartId, isCardPayment: $isCardPayment, shouldApplyCredits: $shouldApplyCredits) {
      ${cartFields}
      taxAmount tipAmount merchantTipAmount deliveryFee appliedServiceFee minOrderFee extraSosDeliveryFee fulfillsOwnDeliveries
      containsAlcohol isMerchantShipping isPrescriptionDelivery isBundle isCatering
      selectedDeliveryOption { deliveryOptionType }
      shouldApplyCredits totalCreditsAvailable { unitAmount currency displayString }
      orders { paymentCard { id } }
      lineItemsList { label finalMoney { unitAmount displayString } }
    }
  }`,
  addCartItem: `mutation addCartItem($addCartItemInput: AddCartItemInput!, $fulfillmentContext: FulfillmentContextInput!, $shouldKeepOnlyOneActiveCart: Boolean) {
    addCartItemV2(addCartItemInput: $addCartItemInput, fulfillmentContext: $fulfillmentContext, shouldKeepOnlyOneActiveCart: $shouldKeepOnlyOneActiveCart) { ${cartFields} }
  }`,
  updateCartItemV2: `mutation updateCartItemV2($updateCartItemInput: UpdateCartItemInput!, $fulfillmentContext: FulfillmentContextInput!) {
    updateCartItemV2(updateCartItemInput: $updateCartItemInput, fulfillmentContext: $fulfillmentContext) { ${cartFields} }
  }`,
  removeCartItemV2: `mutation removeCartItemV2($cartId: ID!, $itemId: ID!) { removeCartItemV2(cartId: $cartId, itemId: $itemId) { id } }`,
  deleteCart: `mutation deleteCart($cartId: ID!) { deleteCart(cartId: $cartId) }`,
  createOrderFromCart: `mutation createOrderFromCart($cartId: ID!, $total: Int!, $sosDeliveryFee: Int!, $isPickupOrder: Boolean!, $verifiedAgeRequirement: Boolean!, $deliveryTime: String!, $storeId: String, $tipAmounts: [TipAmount!], $paymentMethod: Int, $isCardPayment: Boolean, $deliveryOptionType: DeliveryOptionType, $shouldApplyCredits: Boolean) {
    createOrderFromCart(cartId: $cartId, total: $total, sosDeliveryFee: $sosDeliveryFee, isPickupOrder: $isPickupOrder, verifiedAgeRequirement: $verifiedAgeRequirement, deliveryTime: $deliveryTime, storeId: $storeId, tipAmounts: $tipAmounts, paymentMethod: $paymentMethod, isCardPayment: $isCardPayment, deliveryOptionType: $deliveryOptionType, shouldApplyCredits: $shouldApplyCredits) { cartId orderUuid }
  }`,
  pollOrderPaymentStatus: `query pollOrderPaymentStatus($orderId: ID!) { pollOrderPaymentStatus(orderId: $orderId) { paid paymentStatus errorType } }`,
  getConsumerOrdersWithDetails: `query getConsumerOrdersWithDetails($offset: Int!, $limit: Int!, $includeCancelled: Boolean) {
    getConsumerOrdersWithDetails(offset: $offset, limit: $limit, includeCancelled: $includeCancelled) {
      id orderUuid createdAt submittedAt cancelledAt fulfilledAt isPickup
      store { id name }
      grandTotal { unitAmount currency decimalPlaces displayString }
      orders { items { id name quantity } }
    }
  }`,
  autocompleteFacetFeed: `query autocompleteFacetFeed($query: String!) {
    autocompleteFacetFeed(query: $query) {
      body { body { text { title subtitle description } events { click { data } } } }
    }
  }`,
  storepageFeed: `query storepageFeed($storeId: ID!, $isMerchantPreview: Boolean) {
    storepageFeed(storeId: $storeId, isMerchantPreview: $isMerchantPreview) {
      storeHeader { id name description currency offersDelivery offersPickup asapMinutes ratings { averageRating numRatingsDisplayString } }
      menuBook { id name menuCategories { id name numItems } menuList { id name displayOpenHours } }
      itemLists { id name items { id name description displayPrice } }
    }
  }`,
  itemPage: `query itemPage($storeId: ID!, $itemId: ID!, $fulfillmentType: FulfillmentType) {
    itemPage(storeId: $storeId, itemId: $itemId, fulfillmentType: $fulfillmentType) {
      itemHeader { name description unitAmount quantityLimit }
      optionLists { name isOptional minNumOptions maxNumOptions options {
        id name unitAmount displayString nestedExtrasList {
          name isOptional minNumOptions maxNumOptions options { id name unitAmount displayString }
        }
      } }
    }
  }`,
} as const;
